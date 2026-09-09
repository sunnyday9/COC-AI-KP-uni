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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Agent } from 'undici'
import { computeCoverageGaps } from '../../server/src/rag/dossier/coverageGaps.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const STORY_DIR = path.join(ROOT, 'AI-COC-KP Story Document', 'stories')
const FACTS_DIR = path.join(ROOT, 'scripts', 'eval', 'ab-facts')
const CACHE_DIR = path.join(ROOT, 'training', 'eval', 'dossier-cache')
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

/** 触发信号（先 T1 后 T2 后 T3）。 */
const MISSING_RX = /无此信息|无法检索|无法找到|档案中(?:不|没)|未提及|未找到|未收录|没有(?:记载|记录|提到)|不确定|可能是另一个模组/
const WHOLE_TEXT_BUDGET = 22_000 // 字符：整篇直接给的上限（≈20k token 内）
const LOCATED_BUDGET = 20_000 // 字符：定位窗口总预算
const WINDOW = 6_000
const WINDOW_OVERLAP = 400
const ANCHOR_WINDOW = 2_500 // gaps 定位：场景锚点后的取文长度
const ANCHOR_LEAD = 300 // gaps 定位：锚点前的衔接语余量
const GAP_CHUNK = 2_000 // gaps 定位：大 gap 再切块

/* ── 原文读取（pdf-parse，与 readStory 的 pdf 分支同 API）── */
async function pdfText(buffer) {
  const { PDFParse } = await import('pdf-parse')
  const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  const data = await parser.getText()
  return String(data?.text ?? data ?? '')
}

/** 从 dossier-cache 找该剧本档案 JSON（scenes 供 gaps 计算）。 */
function loadCachedDossier(key) {
  const dir = path.join(CACHE_DIR, '1')
  const f = fs.readdirSync(dir).find((x) => x.startsWith(key) && x.endsWith('.json') && !x.includes('.annex.') && !x.includes('.gaps.'))
  if (!f) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  } catch {
    return null
  }
}

/** 场景锚点 + 未覆盖 gap → 内容边界对齐的候选窗口（P22/P23 定位器）。 */
function buildAnchoredWindows(text, scenes) {
  const g = computeCoverageGaps(text, scenes)
  const anchors = g.sceneAnchors.filter((a) => a.matched).flatMap((a) => a.starts ?? []).sort((a, b) => a - b)
  const cands = []
  for (const a of anchors) {
    cands.push({ start: Math.max(0, a - ANCHOR_LEAD), end: Math.min(text.length, a + ANCHOR_WINDOW), kind: 'anchor' })
  }
  for (const sp of g.spans) {
    if (sp.chars <= GAP_CHUNK) {
      cands.push({ start: sp.start, end: Math.min(text.length, sp.end), kind: 'gap' })
    } else {
      for (let s = sp.start; s < sp.end; s += GAP_CHUNK) {
        cands.push({ start: s, end: Math.min(sp.end, s + GAP_CHUNK + 300), kind: 'gap' })
      }
    }
  }
  return cands
}

/** 定位窗口：固定网格（P21 基线）或锚点/gap 对齐窗口（P23）。 */
export function locateRelevant(text, question, scenes, locator) {
  const grams = new Set()
  const cjk = String(question).replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) grams.add(cjk.slice(i, i + 2))
  const score = (slice) => {
    const sCjk = slice.replace(/[^\u4e00-\u9fff]/g, '')
    let s = 0
    for (let i = 0; i + 1 < sCjk.length; i++) if (grams.has(sCjk.slice(i, i + 2))) s++
    return s
  }
  let windows = []
  if (locator === 'gaps' && scenes?.length) {
    const cands = buildAnchoredWindows(text, scenes)
    windows = cands
      .map((c) => ({ ...c, score: score(text.slice(c.start, c.end)) }))
      .filter((w) => w.score > 0)
  } else {
    for (let start = 0; start < text.length; start += WINDOW - WINDOW_OVERLAP) {
      const end = Math.min(text.length, start + WINDOW)
      windows.push({ start, end, kind: 'grid', score: score(text.slice(start, end)) })
      if (end >= text.length) break
    }
    windows = windows.filter((w) => w.score > 0)
  }
  windows.sort((a, b) => b.score - a.score)
  // 取高分窗口（≤12），按原文顺序拼装 ≤ 预算
  const picked = windows.slice(0, 12).sort((a, b) => a.start - b.start)
  let out = ''
  let lastEnd = -1
  for (const w of picked) {
    const seg = w.start > lastEnd ? text.slice(w.start, w.end) : text.slice(lastEnd, w.end)
    if (!seg) continue
    if (out.length + seg.length > LOCATED_BUDGET) break
    if (out && w.start > lastEnd) out += '\n\n……\n\n'
    out += seg
    lastEnd = Math.max(lastEnd, w.end)
  }
  return { text: out, windows: picked.length, locator }
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
  // --input=<fallback json>：重放既有回退结果（只重跑 located 探针，对比定位器）
  const inputPath = arg('input', '')
  const replay = inputPath ? JSON.parse(fs.readFileSync(path.join(ROOT, inputPath), 'utf8')) : null
  const locator = arg('locator', 'grid') // grid（P21 基线）| gaps（P23 锚点/gap 窗口）
  const outPath = arg('out', `training/eval/reports/ab-fallback-${Date.now()}.json`)
  const out = { model: REAL.model, locator, startedAt: Date.now(), stories: {} }
  let nTrigger = 0

  // 收集 (key, coveragePct, probes)：重放模式取 input 的 located 触发问；否则扫报告目录
  const storiesIn = []
  if (replay) {
    for (const [key, s] of Object.entries(replay.stories ?? {})) {
      if (keysFilter.length && !keysFilter.includes(key)) continue
      const probes = (s.probes ?? [])
        .filter((p) => p.trigger && String(p.variant ?? '').startsWith('located') && p.baseline?.score != null)
        .map((p) => ({ ...p, prevFallback: p.fallback ? { score: p.fallback.score, fabrication: p.fallback.fabrication, variant: p.variant } : null }))
      if (probes.length) storiesIn.push({ key, coveragePct: s.coveragePct ?? 100, probes })
    }
  } else {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('ab-recon-annex-') && f.endsWith('.json'))
    for (const f of files.sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      for (const s of Object.values(raw.stories ?? {})) {
        const key = s.key
        if (keysFilter.length && !keysFilter.includes(key)) continue
        const coveragePct = s.gen?.coveragePct ?? 100
        const probes = (s.probes ?? []).filter((p) => p.judge?.score != null)
        if (probes.length) storiesIn.push({ key, coveragePct, probes })
      }
    }
  }

  for (const { key, coveragePct, probes } of storiesIn) {
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
    console.log(`\n=== ${key} === 回退问=${probes.length} coverage=${coveragePct}% 原文=${Math.round(text.length / 1000)}k字符`)
    const factsByQ = loadFactsProbes(key)
    const scenes = loadCachedDossier(key)?.scenes ?? []
    const storyOut = { key, coveragePct, textChars: text.length, probes: [] }
    out.stories[key] = storyOut
    for (const p of probes) {
      nTrigger++
      const meta = factsByQ.get(String(p.q ?? '').trim())
      const rec = {
        cat: p.cat ?? meta?.cat ?? 'fact',
        q: p.q,
        baseline: { score: p.baseline?.score ?? p.judge?.score, fabrication: p.baseline?.fabrication ?? !!p.judge?.fabrication },
        trigger: p.trigger ?? null,
        prevFallback: p.prevFallback ?? null,
      }
      if (!meta) {
        rec.error = 'ab-facts 无此问题（无 refQuote 可 judge）'
        storyOut.probes.push(rec)
        continue
      }
      if (!p.trigger) {
        // 非重放模式：按触发规则筛（T1 缺失信号 / T2 低分 / T3 低覆盖）
        const t = decideTrigger(p, coveragePct)
        if (!t.triggered) {
          storyOut.probes.push(rec)
          continue
        }
        rec.trigger = t
      }
      const prevTxt = p.prevFallback ? `｜旧(grid) ${p.prevFallback.score}${p.prevFallback.fabrication ? '/fab' : ''}` : ''
      console.log(`  [${rec.trigger?.tier ?? '?'}] ${meta.cat} ${meta.q.slice(0, 26)}… 基线=${rec.baseline.score}${prevTxt}`)
      if (!text) {
        rec.error = '原文不可用（pdf 解析失败）'
        storyOut.probes.push(rec)
        continue
      }
      let payload
      let variant
      if (text.length <= WHOLE_TEXT_BUDGET) {
        payload = text
        variant = `whole(${text.length}字符)`
      } else {
        const loc = locateRelevant(text, meta.q, scenes, locator)
        payload = loc.text
        variant = `located-${loc.locator}(${payload.length}字符/${loc.windows}窗)`
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
        const pd = p.prevFallback?.score != null ? rec.fallback.score - p.prevFallback.score : null
        console.log(`    → ${locator} ${rec.fallback.score}${rec.fallback.fabrication ? '/fab' : ''}（Δ基线${d > 0 ? '+' : ''}${d}${pd != null ? `｜Δgrid ${pd > 0 ? '+' : ''}${pd}` : ''}）${rec.fallback.note ?? ''}`)
      }
      storyOut.probes.push(rec)
      await sleep(1200)
    }
  }

  // 汇总
  const all = []
  for (const s of Object.values(out.stories)) for (const p of s.probes) all.push(p)
  const judged = all.filter((p) => p.fallback?.score != null || p.baseline?.score != null)
  const done = all.filter((p) => p.fallback?.score != null)
  const avgOf = (list, pick) => {
    const sc = list.map(pick).filter((x) => x != null)
    return sc.length ? (sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(2) : '—'
  }
  const fabOf = (list, pick) => list.filter((x) => pick(x) === true).length
  console.log('\n==== 汇总（located 重放）====')
  console.log(`基线：avg ${avgOf(done, (p) => p.baseline?.score)}（judged ${done.length}，fab ${fabOf(done, (p) => p.baseline?.fabrication)}）`)
  const gridDone = done.filter((p) => p.prevFallback?.score != null)
  if (gridDone.length) {
    console.log(`旧 grid 回退：avg ${avgOf(gridDone, (p) => p.prevFallback?.score)}（judged ${gridDone.length}，fab ${fabOf(gridDone, (p) => p.prevFallback?.fabrication)}）`)
  }
  console.log(`${locator} 回退：avg ${avgOf(done, (p) => p.fallback?.score)}（judged ${done.length}，fab ${fabOf(done, (p) => p.fallback?.fabrication)}）`)
  console.log(`触发 ${nTrigger} 问，成功 judge ${done.length}，失败 ${all.filter((p) => p.trigger && !p.fallback).length} 条`)
  fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nresults → ${outPath}`)
}

// 直接运行入口（被 import 时不自动执行——便于 eval 脚本互相复用定位函数）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('fallback fail:', e.message)
    process.exit(1)
  })
}
