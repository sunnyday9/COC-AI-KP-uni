/**
 * 离线原文回退验证（P21，实验分支 feature/kp-dossier-workflow）— 用户提议的
 * "档案为主 + 缺失标记 + 原文回退（全新上下文子代理）"架构的最小证据实验。
 *
 * 复用 P20 批量数据（training/eval/reports/ab-recon-annex-<key>.json，57 问已
 * judged 的 dossier 直答基线）。对触发回退的探针：
 *   1) 解析剧本原文（pdf-parse；≤22k 字符整篇给，更大先做轻量词面定位取
 *      相关窗口 ≤20k 字符——模拟"先定位缩窗再回退"，不用 embedding/不用 refQuote）；
 *   2) 原文问答器（一次全新上下文的 LLM 调用 = 子代理）作答；
 *   3) 同一 judge（对照 probe.refQuote）重新打分。
 * 触发规则（任一条）：
 *   T1 缺失信号——dossier 直答或 judge note 含「无此信息/无法检索/未提及…」；
 *   T2 judge 分 ≤2（质量信号）；
 *   T3 档案静态低覆盖（coveragePct < 15，欠抽告警线）。
 *
 * 输出：--out JSON（每问基线/回退/触发原因/delta）；stdout 打 pooled 对比。
 * env：真实 LLM（AB_AI_BASE_URL/AB_AI_API_KEY/OPENCODE_SESSION；llm-env.sh 装载）。
 * 用法：. scripts/eval/llm-env.sh && node scripts/eval/ab-fallback.mjs
 *   [--dir=training/eval/reports] [--out=training/eval/reports/ab-fallback-<ts>.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from 'undici'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const STORY_DIR = path.join(ROOT, 'AI-COC-KP Story Document', 'stories')
const FACTS_DIR = path.join(ROOT, 'scripts', 'eval', 'ab-facts')
const REAL = {
  baseUrl: process.env.AB_AI_BASE_URL ?? '',
  apiKey: process.env.AB_AI_API_KEY ?? '',
  model: process.env.AB_AI_MODEL ?? 'mimo-v2.5',
}
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
const origFetch = globalThis.fetch
globalThis.fetch = (url, opts = {}) => origFetch(url, { ...opts, dispatcher })
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 触发信号（先 T1 后 T2 后 T3；逐条独立统计在 triggerTiers）。 */
const MISSING_RX = /无此信息|无法检索|无法找到|档案中(?:不|没)|未提及|未找到|未收录|没有(?:记载|记录|提到)|不确定|可能是另一个模组/
const WHOLE_TEXT_BUDGET = 22_000 // 字符：整篇直接给的上限（≈20k token 内）
const LOCATED_BUDGET = 20_000 // 字符：定位窗口总预算
const WINDOW = 6_000
const WINDOW_OVERLAP = 400

/* ── 原文读取（pdf-parse，与 readStory 的 pdf 分支同 API）── */
async function pdfText(buffer) {
  const { PDFParse } = await import('pdf-parse')
  const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  const data = await parser.getText()
  return String(data?.text ?? data ?? '')
}

/** CJK 二元组词面定位：分窗打分，取命中多的窗口直到预算（原文顺序拼接）。 */
function locateRelevant(text, question, budget = LOCATED_BUDGET) {
  const grams = new Set()
  const cjk = String(question).replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) grams.add(cjk.slice(i, i + 2))
  const windows = []
  for (let start = 0; start < text.length; start += WINDOW - WINDOW_OVERLAP) {
    const slice = text.slice(start, start + WINDOW)
    let score = 0
    const sCjk = slice.replace(/[^\u4e00-\u9fff]/g, '')
    for (let i = 0; i + 1 < sCjk.length; i++) if (grams.has(sCjk.slice(i, i + 2))) score++
    windows.push({ start, end: start + slice.length, score, slice })
    if (start + WINDOW >= text.length) break
  }
  const picked = windows
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .sort((a, b) => a.start - b.start)
  let out = ''
  for (const w of picked) {
    if (out.length + w.slice.length > budget) break
    out += (out ? '\n\n……\n\n' : '') + w.slice
  }
  return { text: out, windows: picked.length }
}

/* ── LLM 直连（重试 3 次，指数退避；空内容按失败）── */
async function callLLM(messages, maxTokens = 1500) {
  const res = await fetch(`${REAL.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${REAL.apiKey}`,
      ...(process.env.OPENCODE_SESSION ? { 'x-opencode-session': process.env.OPENCODE_SESSION } : {}),
    },
    body: JSON.stringify({ model: REAL.model, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const content = (await res.json()).choices?.[0]?.message?.content ?? ''
  if (!content?.trim()) throw new Error('LLM empty content (reasoning consumed budget)')
  return content
}

async function withRetry(fn, label, attempts = 3) {
  let lastErr = ''
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e.message || String(e)
    }
    if (attempt < attempts - 1) {
      console.log(`  [retry] ${label} #${attempt + 1}: ${lastErr}`)
      await sleep(3000 * (attempt + 1))
    }
  }
  return { error: `after ${attempts} attempts: ${lastErr}` }
}

function parseJudgeJson(raw) {
  const s = String(raw ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

const ORIGINAL_SYSTEM =
  '你是剧本原文问答器。用户给你一部 COC 跑团模组的剧本原文（可能只截取了与问题相关的段落），随后提出关于该剧本的问题。' +
  '你只依据给出的原文回答，不得编造或脑补；给出的原文里没有的信息，明确回答"原文中无此信息"。回答用中文，可引用原文。'

/** 原文子代理作答（全新上下文：只带原文窗口 + 问题）。 */
async function answerFromOriginal(textPayload, q) {
  const raw = await withRetry(
    () =>
      callLLM(
        [
          { role: 'system', content: ORIGINAL_SYSTEM },
          { role: 'user', content: `【剧本原文】\n${textPayload}\n\n【问题】${q}` },
        ],
        1500,
      ),
    'original-answer',
  )
  return typeof raw === 'object' && raw?.error ? raw : { content: raw }
}

/** 从 ab-facts 原文件取探针元数据（refQuote/ref/story——报告 JSON 未存原文引证）。 */
function loadFactsProbes(key) {
  const out = new Map()
  for (const dir of ['', 'v2']) {
    const f = path.join(FACTS_DIR, dir, `${key}.json`)
    if (!fs.existsSync(f)) continue
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    for (const x of data.facts ?? []) {
      if (typeof x.q !== 'string' || !x.q) continue
      out.set(x.q.trim(), { q: x.q.trim(), refQuote: String(x.refQuote ?? ''), ref: String(x.ref ?? ''), story: data.story ?? key, cat: x.cat ?? 'fact' })
    }
  }
  return out
}

/** 与 ab-reconstruct 同口径的 judge（对照 probe.refQuote 打 1-5 + fab）。 */
async function judgeAnswer(storyTitle, probe, answer) {
  const ask =
    `你是剧本事实一致性评审。剧本《${storyTitle}》。一个"原文问答器"只凭剧本原文（可能只截取相关段落）回答了下面的问题，` +
    `请对照剧本原文依据判断它的回答是否忠于剧本。\n\n` +
    `【问题】${probe.q}\n` +
    `【剧本原文依据】${probe.refQuote}\n` +
    `【要点】${probe.ref}\n\n` +
    `【原文问答器回答】\n${String(answer ?? '（无回答）').slice(0, 1000)}\n\n` +
    `按 1-5 打忠实度分（5=要点全中且准确；3=大体正确但有含糊/细节偏离；1=答非所问、与依据矛盾、或原文缺该信息而未能回答）。` +
    `fabrication=true 仅当回答与上述摘录直接冲突或明显超出剧本范围（编造 NPC/地点/真相）；摘录片段未覆盖、但可能属剧本其他部分的细节，不算 fabrication（可在 note 说明存疑）。` +
    `原文缺少该信息导致"原文中无此信息"式的如实回答时，打 1 分且 fabrication=false（这暴露的正是原文截取窗口的覆盖缺口）。` +
    `只输出 JSON：{"score":1-5,"fabrication":true/false,"note":"≤60字"}`
  const raw = await withRetry(() => callLLM([{ role: 'user', content: ask }], 4000), 'judge', 3)
  if (raw && typeof raw === 'object' && raw?.error) return raw
  const j = parseJudgeJson(raw)
  if (j && j.score != null) return j
  return { error: `unparseable judge output: ${String(raw ?? '').slice(0, 120)}` }
}

function decideTrigger(probe, coveragePct) {
  const answer = String(probe.answer ?? '')
  const note = String(probe.judge?.note ?? '')
  if (MISSING_RX.test(answer) || MISSING_RX.test(note)) {
    const hit = (answer.match(MISSING_RX) ?? note.match(MISSING_RX) ?? [''])[0]
    return { triggered: true, tier: 'T1', reason: `缺失信号「${hit}」` }
  }
  if ((probe.judge?.score ?? 5) <= 2) return { triggered: true, tier: 'T2', reason: `judge 分 ${probe.judge.score} ≤2` }
  if (coveragePct < 15) return { triggered: true, tier: 'T3', reason: `档案覆盖率 ${coveragePct}% <15（欠抽）` }
  return { triggered: false, tier: null, reason: '' }
}

async function main() {
  if (!REAL.baseUrl || !REAL.apiKey) {
    console.error('need AB_AI_BASE_URL + AB_AI_API_KEY（. scripts/eval/llm-env.sh）')
    process.exit(1)
  }
  const dir = arg('dir', path.join(ROOT, 'training', 'eval', 'reports'))
  const keysFilter = (arg('keys', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const outPath = arg('out', `training/eval/reports/ab-fallback-${Date.now()}.json`)
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('ab-recon-annex-') && f.endsWith('.json'))
  const out = { model: REAL.model, startedAt: Date.now(), stories: {} }
  let nTrigger = 0
  let nBaseline = 0

  for (const f of files.sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    for (const s of Object.values(raw.stories ?? {})) {
      const key = s.key
      if (keysFilter.length && !keysFilter.includes(key)) continue
      const coveragePct = s.gen?.coveragePct ?? 100
      const probes = (s.probes ?? []).filter((p) => p.judge?.score != null)
      if (!probes.length) continue
      // 剧本原文（pdf-parse；OCR 前纯文本——图载文字属 annex 通道，不在本验证范围）
      const pdfPath = path.join(STORY_DIR, `${key}.pdf`)
      let text = ''
      if (fs.existsSync(pdfPath)) {
        try {
          text = (await pdfText(fs.readFileSync(pdfPath))).trim()
        } catch (e) {
          console.log(`[warn] ${key}: pdf 解析失败 ${e.message}`)
        }
      }
      console.log(`\n=== ${key} === probes=${probes.length} coverage=${coveragePct}% 原文=${Math.round(text.length / 1000)}k字符`)
      const factsByQ = loadFactsProbes(key)
      const storyOut = { key, coveragePct, textChars: text.length, probes: [] }
      out.stories[key] = storyOut
      for (const p of probes) {
        nBaseline++
        const meta = factsByQ.get(String(p.q ?? '').trim())
        if (!meta) {
          storyOut.probes.push({ cat: p.cat ?? 'fact', q: p.q, baseline: { score: p.judge?.score, fabrication: !!p.judge?.fabrication }, error: 'ab-facts 无此问题（无 refQuote 可 judge）' })
          continue
        }
        const rec = {
          cat: meta.cat,
          q: meta.q,
          baseline: { score: p.judge?.score, fabrication: !!p.judge?.fabrication },
        }
        const t = decideTrigger(p, coveragePct)
        if (!t.triggered) {
          rec.trigger = null
          storyOut.probes.push(rec)
          continue
        }
        nTrigger++
        rec.trigger = { tier: t.tier, reason: t.reason }
        console.log(`  [trigger ${t.tier}] ${meta.cat} ${meta.q.slice(0, 30)}… 基线=${p.judge?.score}${p.judge?.fabrication ? '/fab' : ''} — ${t.reason}`)
        if (!text) {
          rec.error = '原文不可用（pdf 解析失败）'
          storyOut.probes.push(rec)
          continue
        }
        // 原文窗口：小剧本整篇；大剧本词面定位
        let payload
        let variant
        if (text.length <= WHOLE_TEXT_BUDGET) {
          payload = text
          variant = `whole(${text.length}字符)`
        } else {
          const loc = locateRelevant(text, meta.q)
          payload = loc.text
          variant = `located(${payload.length}字符/${loc.windows}窗)`
          if (!payload) {
            rec.error = '定位无命中窗口（窗口词面与问题无交集）'
            storyOut.probes.push(rec)
            continue
          }
        }
        const ans = await answerFromOriginal(payload, meta.q)
        if (ans?.error) {
          rec.error = `原文回答失败: ${ans.error}`
          storyOut.probes.push(rec)
          continue
        }
        rec.variant = variant
        rec.answer = String(ans.content ?? '').slice(0, 1200)
        const j = await judgeAnswer(meta.story, meta, rec.answer)
        if (j?.error) {
          rec.judgeError = j.error
        } else {
          rec.fallback = { score: j.score, fabrication: !!j.fabrication, note: j.note }
          const d = rec.fallback.score - rec.baseline.score
          console.log(`    → 回退 ${rec.fallback.score}${rec.fallback.fabrication ? '/fab' : ''}（Δ${d > 0 ? '+' : ''}${d}）${rec.fallback.note ?? ''}`)
        }
        storyOut.probes.push(rec)
        await sleep(1200)
      }
    }
  }
  // pooled 汇总：基线全部 vs 触发子集 vs 复合（未触发用基线、触发用回退）
  const all = []
  for (const s of Object.values(out.stories)) for (const p of s.probes) all.push(p)
  const scored = all.filter((p) => p.baseline?.score != null)
  const triggered = scored.filter((p) => p.trigger && p.fallback?.score != null)
  const nonTriggered = scored.filter((p) => !p.trigger)
  const composite = [...nonTriggered, ...triggered]
  const avg = (list) => {
    if (!list.length) return '—'
    const sum = list.reduce((acc, p) => acc + (p.baseline?.score ?? 0), 0)
    return (sum / list.length).toFixed(2)
  }
  // composite 用 fallback.score（触发）或 baseline.score
  const avgComp = (list) => {
    if (!list.length) return '—'
    const sum = list.reduce((acc, p) => acc + (p.fallback?.score ?? p.baseline?.score ?? 0), 0)
    return (sum / list.length).toFixed(2)
  }
  const fabOf = (list, field) => list.filter((p) => (field === 'fallback' ? p.fallback?.fabrication : p.baseline?.fabrication)).length
  const triggerFailures = all.filter((p) => p.trigger && !p.fallback && !p.judgeError && !p.error).length
  console.log('\n==== 汇总 ====')
  console.log(`基线全部：avg ${avg(scored)}（judged ${scored.length}，fab ${fabOf(scored, 'baseline')}）`)
  console.log(`触发子集基线：avg ${avg(triggered)}（judged ${triggered.length}，fab ${fabOf(triggered, 'baseline')}）`)
  console.log(`触发子集回退：avg ${avgComp(triggered)}（judged ${triggered.length}，fab ${fabOf(triggered, 'fallback')}）`)
  console.log(`复合（未触发用基线 + 触发用回退）：avg ${avgComp(composite)}（judged ${composite.length}）`)
  console.log(`触发 ${nTrigger} 问（有回退结果 ${triggered.length}），失败/异常 ${all.filter((p) => p.trigger && (!p.fallback || p.error)).length} 条`)
  fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nresults → ${outPath}`)
}

main().catch((e) => {
  console.error('fallback fail:', e.message)
  process.exit(1)
})
