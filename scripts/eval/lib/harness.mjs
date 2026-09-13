/**
 * scripts/eval A/B harness 共享帮助函数单源（#64，架构扫描候选 8）。
 *
 * estTokens 此前三份（ab-compare / ab-reconstruct / ab-dossier-metrics）口径漂移
 * 会让跨报告 token 对比失效 → 收敛此单源；改公式 = 改接口，历史报告对比会静默失真。
 * 同名但有行为差异的副本（ab-compare 的 api/step/cleanup/sleep 排版、registerUser
 * 前缀等）保留在各脚本本地——不为抽取而统一行为。对照表见 issue #64。
 * parseJudgeJson 为 #82 收编；pdfText / loadFactsProbes / buildJudgePrompt 为 #87
 * 收编（ab-verify-runtime + ab-fallback 双侧逐字副本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const FACTS_DIR = path.join(ROOT, 'scripts', 'eval', 'ab-facts')

/**
 * token 估算单源（口径：CJK ≈0.9 tok/字，非 CJK ≈3.5 char/tok，四舍五入）。
 * 与被收编的三份本地副本公式逐值等价（对拍样本见 #64 验收记录）。
 */
export function estTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return Math.round(cjk * 0.9 + (s.length - cjk) / 3.5)
}

/** 从 LLM judge 输出里抠 JSON（首 `{` 到末 `}`）；解析失败返回 null。 */
export function parseJudgeJson(raw) {
  const s = String(raw ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 PDF 为纯文本（pdf-parse，与 readStory 的 pdf 分支同 API；#87 自 ab-fallback/ab-verify-runtime 收编）。 */
export async function pdfText(buffer) {
  const { PDFParse } = await import('pdf-parse')
  const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  const data = await parser.getText()
  return String(data?.text ?? data ?? '')
}

/** 从 ab-facts 原文件取探针元数据（refQuote/ref/story——报告 JSON 未存原文引证；#87 自双侧逐字副本收编）。 */
export function loadFactsProbes(key) {
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

/** judge 提示词单源（对照 probe.refQuote 打 1-5 + fab；#87 自双侧逐字同源 ask 串收编）。 */
export function buildJudgePrompt(storyTitle, probe, answer) {
  return (
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
  )
}

/**
 * cleanup 依赖各脚本的模块级 children 数组 → 工厂注入。
 * 内层函数体与 ab-reconstruct / ab-dossier-metrics 的本地副本逐字节相同。
 */
export function createCleanup(children) {
  return async function cleanup() {
    for (const c of children) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
        else c.kill('SIGTERM')
      } catch { /* ignore */ }
    }
    await sleep(800)
  }
}
