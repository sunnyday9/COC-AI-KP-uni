/**
 * 运行时「原文查证」工具离线直答评测（P25，实验分支 feature/kp-dossier-workflow）。
 *
 * 直接调用 **运行时代码**（server/src/rag/dossier/originalLookup.ts）而不是复制一份
 * 原型逻辑：deps 由本脚本注入（原文走 pdf-parse 纯文本、gaps/dossier 走
 * dossier-cache 的 .json），LLM 走直连（与 ab-fallback 同口径）。每个 ab-facts
 * 探针问一次工具 → 同一 judge（对照 probe.refQuote 打 1-5 + fabrication）。
 *
 * 为什么这是 P25 的 (b) 度量：P10 已证明"对局后追问"不能当主度量（KP 还在扮演
 * 状态、防剧透会拒答）。工具直答是**全新上下文**的事实核对——与 P21/P23 的回退
 * 子代理完全同口径，可直接与那批数字对比。
 *
 * --scene=auto（默认）| none | <场景名>：auto 用 dossier.lexicalSearch(question)
 * 的首个 scene 命中当"当前场景"（模拟 KP 在相关场景中提问 → tier=scene），
 * none = 不给场景（走全篇词面兜底 tier=global），显式名字 = 钉死某场景。
 *
 * 用法：
 *   . scripts/eval/llm-env.sh && node scripts/eval/ab-verify-runtime.mjs \
 *     --keys=火焰交织的盛夏_220819_compressed,-营一日的恐怖_20231103 \
 *     [--scene=auto|none|<名>] [--out=training/eval/reports/ab-verify-runtime-<tag>.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Agent } from 'undici'

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

/** 铁律 1：模型守卫——-pro 变体拒绝（无视觉/上游 404）。 */
function assertNonPro(model) {
  if (/-pro\b|-pro$/i.test(String(model ?? ''))) {
    throw new Error(`拒绝 -pro 模型：${model}（mimo-v2.5-pro 不受支持）`)
  }
  return model
}

/* ── 运行时代码（TS 直载；deps 全注入，不触发 server 的 db/express 路径）── */
const { verifyOriginal, clearVerifyCaches } = await import('../../server/src/rag/dossier/originalLookup.ts')
const { lexicalSearch } = await import('../../server/src/rag/dossier/storyDossierService.ts')

/* ── 原文/缓存读取（与 ab-fallback 同口径）── */
async function pdfText(buffer) {
  const { PDFParse } = await import('pdf-parse')
  const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  const data = await parser.getText()
  return String(data?.text ?? data ?? '')
}

function cacheFiles(key) {
  const dir = path.join(CACHE_DIR, '1')
  if (!fs.existsSync(dir)) return { dossier: null, gaps: null }
  const files = fs.readdirSync(dir)
  const d = files.find((x) => x.startsWith(key) && x.endsWith('.json') && !x.includes('.annex.') && !x.includes('.gaps.'))
  const g = files.find((x) => x === `${key}.gaps.json` || (x.startsWith(key) && x.endsWith('.gaps.json')))
  const read = (f) => {
    if (!f) return null
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null }
  }
  return { dossier: read(d), gaps: read(g) }
}

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

/* ── LLM（直连；重试 ≥3 指数退避；空内容按失败）── */
async function callLLM(messages, maxTokens = 1500) {
  assertNonPro(REAL.model)
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
  throw new Error(`after ${attempts} attempts: ${lastErr}`)
}

function parseJudgeJson(raw) {
  const s = String(raw ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

/** 与 ab-reconstruct / ab-fallback 同口径的 judge（对照 probe.refQuote）。 */
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
  const j = parseJudgeJson(raw)
  if (j && j.score != null) return j
  throw new Error(`unparseable judge output: ${String(raw ?? '').slice(0, 120)}`)
}

/* ── 主流程 ── */

async function main() {
  if (!REAL.baseUrl || !REAL.apiKey) {
    console.error('need AB_AI_BASE_URL + AB_AI_API_KEY（. scripts/eval/llm-env.sh）')
    process.exit(1)
  }
  assertNonPro(REAL.model)
  const keys = (arg('keys', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!keys.length) {
    console.error('need --keys=<key,key>')
    process.exit(1)
  }
  const sceneMode = arg('scene', 'auto')
  const outPath = arg('out', `training/eval/reports/ab-verify-runtime-${Date.now()}.json`)
  const out = { model: REAL.model, tool: 'verify_original', sceneMode, startedAt: Date.now(), stories: {} }
  console.log(`模型=${REAL.model} scene=${sceneMode}`)

  for (const key of keys) {
    const pdfPath = path.join(STORY_DIR, `${key}.pdf`)
    if (!fs.existsSync(pdfPath)) {
      console.log(`[warn] ${key}: 找不到 ${pdfPath}`)
      continue
    }
    const text = (await pdfText(fs.readFileSync(pdfPath))).trim()
    const { dossier, gaps } = cacheFiles(key)
    const facts = loadFactsProbes(key)
    if (!facts.size) {
      console.log(`[warn] ${key}: ab-facts 无探针`)
      continue
    }
    console.log(`\n=== ${key} === 原文=${Math.round(text.length / 1000)}k 字符｜scenes=${dossier?.scenes?.length ?? 0}｜gaps spans=${gaps?.spans?.length ?? 0}｜探针=${facts.size}`)
    const storyOut = { key, textChars: text.length, coveragePct: dossier?.coverageGaps?.pct ?? null, probes: [] }
    out.stories[key] = storyOut

    for (const probe of facts.values()) {
      let scene
      if (sceneMode === 'none') scene = undefined
      else if (sceneMode === 'auto') {
        const hits = dossier ? lexicalSearch(dossier, probe.q, 5) : []
        scene = hits.find((h) => h.kind === 'scene')?.name
      } else scene = sceneMode

      const t0 = Date.now()
      let res
      try {
        res = await withRetry(
          () =>
            verifyOriginal(
              { question: probe.q, scene },
              {
                userId: 1,
                scriptId: key,
                loadStoryText: async () => text,
                loadGaps: async () => gaps,
                loadDossier: async () => dossier,
                ask: (messages, maxTokens) => callLLM(messages, maxTokens),
              },
            ),
          `verify:${probe.q.slice(0, 16)}`,
          3,
        )
      } catch (e) {
        storyOut.probes.push({ q: probe.q, cat: probe.cat, scene, error: e.message })
        console.log(`  [err] ${probe.q.slice(0, 24)}… ${e.message}`)
        continue
      }
      const rec = {
        cat: probe.cat,
        q: probe.q,
        scene: scene ?? null,
        tier: res.meta.tier,
        spoiler: res.meta.spoiler,
        spoilerReason: res.meta.spoilerReason,
        ok: res.meta.ok,
        reason: res.meta.reason,
        chars: res.meta.chars,
        content: res.content,
        ms: Date.now() - t0,
      }
      if (!res.meta.ok) {
        // 工具自述「未取得」也算一种结果（judge 会按"原文缺该信息"打 1 分）
        rec.note = '工具返回未取得'
      }
      try {
        const j = await judgeAnswer(probe.story, probe, res.content)
        rec.judge = { score: j.score, fabrication: !!j.fabrication, note: j.note }
      } catch (e) {
        rec.judgeError = e.message
      }
      storyOut.probes.push(rec)
      const jd = rec.judge ? `${rec.judge.score}${rec.judge.fabrication ? '/fab' : ''}` : `judge错误`
      console.log(`  [${rec.tier}/${rec.spoiler}] ${probe.q.slice(0, 22)}… → ${jd}（${rec.chars}字符 ${rec.ms}ms）${rec.judge?.note ?? ''}`)
      await sleep(800)
    }
    clearVerifyCaches()
  }

  const all = Object.values(out.stories).flatMap((s) => s.probes)
  const judged = all.filter((p) => p.judge?.score != null)
  const avg = judged.length ? (judged.reduce((a, p) => a + p.judge.score, 0) / judged.length).toFixed(2) : '—'
  const fab = judged.filter((p) => p.judge.fabrication).length
  const tierCounts = all.reduce((acc, p) => { acc[p.tier ?? 'err'] = (acc[p.tier ?? 'err'] || 0) + 1; return acc }, {})
  console.log(`\n==== 汇总（verify_original 直答，scene=${sceneMode}）====`)
  console.log(`judged ${judged.length}/${all.length}｜avg ${avg}｜fab ${fab}｜tier ${JSON.stringify(tierCounts)}`)
  console.log(`耗时中位 ${all.map((p) => p.ms).sort((a, b) => a - b)[Math.floor(all.length / 2)] ?? '—'}ms`)
  fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nresults → ${outPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('verify-runtime fail:', e.message)
    process.exit(1)
  })
}
