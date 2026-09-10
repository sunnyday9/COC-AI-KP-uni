/**
 * 运行时「原文查证」工具（P25，实验分支 feature/kp-dossier-workflow）。
 *
 * P21/P23 的离线结论：档案缺失时的原文回退中，"问题→20k 窗"的词面定位有上限；
 * 运行时必须做**场景级定向**——按当前场景在原文中的锚点（coverageGaps 的
 * sceneAnchors.starts[]）取窗口，再叠加与该场景相交的 gap spans（档案丢掉的
 * 原文段）。只有当场景窗口对问题全无词面命中时，才退到全篇锚点/gap 的词面
 * 兜底（tier='global'）。
 *
 * 查询本身 = 一次**全新上下文**的 LLM 调用（原文窗口 + 问题 → 事实答案 + 逐字
 * 引用），不把档案/剧情注入该子调用——它只回答"原文怎么说"。
 *
 * 剧透 gate（口径写进工具描述与 kpPromptService 的知识源说明）：真相/结局类
 * 问句、或所选原文窗口与某条 truth.revealScene 的锚点相交时，结果标注
 * 「仅限 KP 内部裁定，禁止向玩家复述」——是降级标注而非拒绝，KP 仍可用它裁定。
 *
 * 降级（不阻断回合）：原文缺失 / 定位不到 / LLM 失败或空答 → 返回明确的
 * 「未取得」文本；同问同场景命中进程内 TTL 缓存（默认 10 分钟，原文与档案在
 * 一局内是静态的）。所有 IO 走注入缝（loadStoryText/loadGaps/loadDossier/ask），
 * 单测不触网不落盘。
 *
 * 会话回填注意：kpTurnService 对工具结果做摘要 + 600 字符截断，本模块渲染上限
 * MAX_CONTENT_CHARS=580，保证 KP 看到的内容不被砍。
 */
import { chatForRag } from '../../services/aiService.js'
import { readStoryForRag } from '../../services/storyService.js'
import { loadGaps, type CoverageGaps } from './coverageGaps.js'
import { loadDossier, findScene } from './storyDossierService.js'
import { BadRequestError } from '../../utils/errors.js'
import type { ChatMessage } from '../../services/llm/types.js'
import type { StoryDossier } from './schema.js'

/** 场景锚点前的衔接语余量（与 ab-fallback 的 ANCHOR_LEAD 同口径）。 */
export const ANCHOR_LEAD = 300
/** 场景锚点后的取文长度（与 ab-fallback 的 ANCHOR_WINDOW 同口径）。 */
export const ANCHOR_SPAN = 2_500
/** 单次查证的原文窗口总预算（字符）。 */
export const DEFAULT_BUDGET = 12_000
/** 回填给 KP 的内容上限（kpTurnService 截断线 600 之内）。 */
export const MAX_CONTENT_CHARS = 580
/** 答案/引用渲染上限（字符）。 */
const ANSWER_MAX_CHARS = 220
const QUOTE_MAX_CHARS = 120
/** 定位窗口：长 gap span 再切块（+重叠）——与 ab-fallback 的 GAP_CHUNK 同口径。 */
const GAP_CHUNK = 2_000
const GAP_CHUNK_OVERLAP = 300
/** 答案缓存 TTL（进程内；一局内原文/档案静态）。 */
const CACHE_TTL_MS = 10 * 60_000
/** 单次查证的 LLM 尝试次数（短暂失败重试一次；仍失败则降级「未取得」）。 */
const ASK_ATTEMPTS = 2
const ASK_BACKOFF_MS = 500
/** 答案输出预算：推理模型（mimo-v2.5）reasoning 会吃 output budget——太小会截断
 * JSON 或空响应（P25 首轮实测 1200 时 2/5 空响应、1/5 JSON 截断）。 */
const ASK_MAX_TOKENS = 4_000

export type WindowKind = 'anchor' | 'gap'
export type LocateTier = 'scene' | 'global' | 'none'
export type SpoilerLevel = 'normal' | 'kp_only'

export interface LocateWindow {
  start: number
  end: number
  kind: WindowKind
  sceneId?: string
  sceneName?: string
  score?: number
}

export interface LocatedText {
  text: string
  windows: LocateWindow[]
  tier: LocateTier
  chars: number
  sceneId?: string
  sceneName?: string
}

/* ═══════════════════ 定位（纯函数） ═══════════════════ */

function clampWindow(start: number, end: number, len: number): { start: number; end: number } {
  return { start: Math.max(0, start), end: Math.min(len, end) }
}

/** 场景锚点 → 内容窗口（start-LEAD .. start+SPAN）+ 与该场景范围相交的 gap span。 */
export function buildSceneWindows(
  storyText: string,
  gaps: CoverageGaps | null,
  scene: { id: string; name: string } | null,
): LocateWindow[] {
  const text = String(storyText ?? '')
  if (!text || !gaps || !scene) return []
  const anchor = (gaps.sceneAnchors ?? []).find((a) => a.id === scene.id || a.name === scene.name)
  const starts = (anchor?.matched ? anchor.starts ?? [] : []).filter((s) => Number.isFinite(s)).sort((a, b) => a - b)
  if (starts.length === 0) return []
  const windows: LocateWindow[] = starts.map((s) => {
    const w = clampWindow(s - ANCHOR_LEAD, s + ANCHOR_SPAN, text.length)
    return { ...w, kind: 'anchor', sceneId: scene.id, sceneName: scene.name }
  })
  const first = starts[0] as number
  const last = starts[starts.length - 1] as number
  const rangeStart = Math.max(0, first - ANCHOR_LEAD)
  const rangeEnd = Math.min(text.length, last + ANCHOR_SPAN)
  for (const sp of gaps.spans ?? []) {
    if (sp.end <= rangeStart || sp.start >= rangeEnd) continue
    windows.push({ start: sp.start, end: sp.end, kind: 'gap', sceneId: scene.id, sceneName: scene.name })
  }
  return windows
}

/** 全篇候选：所有已锚场景的锚点窗口 + 所有 gap span（长 gap 再切块）。 */
export function buildGlobalWindows(storyText: string, gaps: CoverageGaps | null): LocateWindow[] {
  const text = String(storyText ?? '')
  if (!text || !gaps) return []
  const windows: LocateWindow[] = []
  for (const a of gaps.sceneAnchors ?? []) {
    for (const s of a.matched ? a.starts ?? [] : []) {
      if (!Number.isFinite(s)) continue
      const w = clampWindow(s - ANCHOR_LEAD, s + ANCHOR_SPAN, text.length)
      windows.push({ ...w, kind: 'anchor', sceneId: a.id, sceneName: a.name })
    }
  }
  for (const sp of gaps.spans ?? []) {
    if (sp.chars <= GAP_CHUNK) {
      windows.push({ start: sp.start, end: Math.min(text.length, sp.end), kind: 'gap' })
      continue
    }
    for (let s = sp.start; s < sp.end; s += GAP_CHUNK) {
      windows.push({ start: s, end: Math.min(sp.end, s + GAP_CHUNK + GAP_CHUNK_OVERLAP), kind: 'gap' })
    }
  }
  return windows
}

/** 问题词面评分：CJK 二元组命中数（与 ab-fallback locateRelevant 同口径）。 */
export function questionScore(slice: string, question: string): number {
  const grams = new Set<string>()
  const cjk = String(question).replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) grams.add(cjk.slice(i, i + 2))
  if (grams.size === 0) return 0
  const body = String(slice).replace(/[^\u4e00-\u9fff]/g, '')
  let score = 0
  for (let i = 0; i + 1 < body.length; i++) if (grams.has(body.slice(i, i + 2))) score++
  return score
}

/** 给窗口打问题相关分并按分降序（稳定：同分保持传入顺序）。 */
export function scoreWindows(storyText: string, windows: LocateWindow[], question: string): LocateWindow[] {
  return windows
    .map((w, i) => ({ w: { ...w, score: questionScore(storyText.slice(w.start, w.end), question) }, i }))
    .sort((a, b) => (b.w.score ?? 0) - (a.w.score ?? 0) || a.i - b.i)
    .map((x) => x.w)
}

/** 窗口集合 → 拼接文本：按原文顺序、重叠区不重复、窗口间断处加省略分隔。 */
function assembleWindows(storyText: string, windows: LocateWindow[]): { text: string; windows: LocateWindow[] } {
  const ordered = [...windows].sort((a, b) => a.start - b.start)
  let out = ''
  let lastEnd = -1
  for (const w of ordered) {
    const from = w.start > lastEnd ? w.start : lastEnd
    const seg = storyText.slice(from, w.end)
    if (!seg) continue
    if (out && w.start > lastEnd) out += '\n\n……\n\n'
    out += seg
    lastEnd = Math.max(lastEnd, w.end)
  }
  return { text: out, windows: ordered }
}

/** 按优先级（高分在前）在预算内选窗；每加一窗都重算拼接文本，保证总量 ≤ 预算。 */
export function selectWindows(
  storyText: string,
  windows: LocateWindow[],
  budget: number = DEFAULT_BUDGET,
): { text: string; windows: LocateWindow[]; chars: number } {
  const text = String(storyText ?? '')
  let picked: LocateWindow[] = []
  let assembled = { text: '', windows: [] as LocateWindow[] }
  for (const w of windows) {
    if (w.end <= w.start) continue
    const trial = [...picked, w]
    const candidate = assembleWindows(text, trial)
    if (candidate.text.length > budget) continue
    picked = trial
    assembled = candidate
  }
  return { text: assembled.text, windows: assembled.windows, chars: assembled.text.length }
}

/**
 * 定位分层：场景级优先（当前场景锚点窗口 + 相交 gap），无命中才退全篇词面兜底。
 * 场景窗口吃不满预算时，用全篇词面命中的窗口补足（P21/P23 证据：跨场景的补充
 * 原文能显著抬升回答质量，预算空着才是浪费）。tier='none' 表示既无场景窗口也无
 * 词面命中——调用方据此降级「未取得」。
 */
export function locateForQuestion(
  storyText: string,
  gaps: CoverageGaps | null,
  dossier: StoryDossier | null,
  sceneNameOrId: string | undefined,
  question: string,
  budget: number = DEFAULT_BUDGET,
): LocatedText {
  const text = String(storyText ?? '')
  const scene = dossier && sceneNameOrId ? findScene(dossier, sceneNameOrId) : null
  const sceneTarget = scene ? { id: scene.id, name: scene.name } : null
  const sceneWins = buildSceneWindows(text, gaps, sceneTarget)
  const scoredScene = scoreWindows(text, sceneWins, question)
  const sceneHits = scoredScene.filter((w) => (w.score ?? 0) > 0)
  const globalHits = scoreWindows(text, buildGlobalWindows(text, gaps), question).filter((w) => (w.score ?? 0) > 0)

  if (sceneWins.length > 0 && sceneHits.length > 0) {
    // 场景窗口优先；全篇命中窗口（去重）按分数序补足预算
    const seen = new Set(scoredScene.map((w) => `${w.start}:${w.end}`))
    const pool = [...scoredScene, ...globalHits.filter((w) => !seen.has(`${w.start}:${w.end}`))]
    const picked = selectWindows(text, pool, budget)
    return { ...picked, tier: 'scene', sceneId: scene?.id, sceneName: scene?.name }
  }

  if (globalHits.length > 0) {
    const picked = selectWindows(text, globalHits, budget)
    return { ...picked, tier: 'global', sceneId: scene?.id, sceneName: scene?.name }
  }
  if (sceneWins.length > 0) {
    // 场景窗口存在但对问题零命中：仍给出场景原文（KP 可据此确认"原文没写"）
    const picked = selectWindows(text, scoredScene, budget)
    return { ...picked, tier: 'scene', sceneId: scene?.id, sceneName: scene?.name }
  }
  return { text: '', windows: [], chars: 0, tier: 'none', sceneId: scene?.id, sceneName: scene?.name }
}

/* ═══════════════════ 剧透 gate（纯函数） ═══════════════════ */

/** 真相/结局类问句的词面信号（降级为 KP 内部裁定，非拒绝）。 */
const SPOILER_RX = /真相|结局|幕后|黑手|真凶|主谋|阴谋|最终|为什么|为何|目的|隐藏|动机|秘密|陷阱|会怎样/

export function classifySpoiler(
  question: string,
  dossier: StoryDossier | null,
  gaps: CoverageGaps | null,
  selected: LocateWindow[],
): { level: SpoilerLevel; reason: string } {
  if (SPOILER_RX.test(String(question ?? ''))) {
    return { level: 'kp_only', reason: 'query-sensitivity' }
  }
  // 所选窗口落在某真相的 revealScene 锚点范围内 → 同样按剧透层处理
  for (const t of dossier?.truths ?? []) {
    if (!t.revealScene) continue
    const scene = findScene(dossier as StoryDossier, t.revealScene)
    const name = scene?.name ?? t.revealScene
    const anchor = (gaps?.sceneAnchors ?? []).find((a) => a.id === name || a.name === name || a.id === scene?.id)
    const starts = anchor?.matched ? anchor.starts ?? [] : []
    for (const s of starts) {
      const rs = s - ANCHOR_LEAD
      const re = s + ANCHOR_SPAN
      if (selected.some((w) => w.start < re && w.end > rs)) {
        return { level: 'kp_only', reason: `reveal-scene-overlap:${name}` }
      }
    }
  }
  return { level: 'normal', reason: 'none' }
}

/* ═══════════════════ 渲染 ═══════════════════ */

export interface VerifyRenderInput {
  answer: string
  quote?: string
  sceneName?: string
  spoiler: SpoilerLevel
}

function clip(s: string, max: number): { text: string; clipped: boolean } {
  const str = String(s ?? '').trim()
  if (str.length <= max) return { text: str, clipped: false }
  return { text: str.slice(0, max), clipped: true }
}

/** 渲染工具回填内容：结论 + 逐字引用；剧透层加标注；总长 ≤ MAX_CONTENT_CHARS。 */
export function renderVerifyContent(input: VerifyRenderInput): string {
  const prefix =
    (input.spoiler === 'kp_only' ? '【剧透层·仅限 KP 内部裁定，禁止向玩家复述】' : '') +
    `【原文查证${input.sceneName ? `·${input.sceneName}` : ''}】`
  const answer = clip(input.answer, ANSWER_MAX_CHARS)
  const quote = clip(input.quote ?? '', QUOTE_MAX_CHARS)
  let out = `${prefix}${answer.text}${answer.clipped ? '…' : ''}`
  if (quote.text) out += `\n【原文】"${quote.text}${quote.clipped ? '…' : ''}"`
  if (out.length > MAX_CONTENT_CHARS) out = out.slice(0, MAX_CONTENT_CHARS - 1) + '…'
  return out
}

/** 无定位/失败时的显式降级文本（KP 据此叙事"原文未载"，不阻断回合）。 */
export function renderUnavailable(reason: string): string {
  return `【原文查证】未取得：${reason}。请不要编造该信息，改为基于已知档案与当前场景叙事，或让调查员以行动获取。`
}

/* ═══════════════════ 原文读取缓存 ═══════════════════ */

const textCache = new Map<string, { at: number; text: string }>()
const answerCache = new Map<string, { at: number; content: string; meta: VerifyMeta }>()
/** 答案缓存条目上限（防长局无界增长；超出清最早写入项）。 */
const ANSWER_CACHE_MAX = 200
/** 原文缓存条目上限（每篇可到 200k 字符）。 */
const TEXT_CACHE_MAX = 8

export function clearVerifyCaches(): void {
  textCache.clear()
  answerCache.clear()
}

/* ═══════════════════ 查证执行 ═══════════════════ */

export interface VerifyMeta {
  ok: boolean
  tier: LocateTier
  spoiler: SpoilerLevel
  sceneId?: string
  sceneName?: string
  cached: boolean
  /** 定位到的原文窗口字符数。 */
  chars: number
  /** 降级原因（ok=false 时）。 */
  reason?: string
  /** 答案来源窗口层级/剧透判定的原因串（报告核对用）。 */
  spoilerReason?: string
  durationMs: number
}

export interface VerifyOriginalDeps {
  userId: number
  scriptId: string
  /** 原文读取（缺省 readStoryForRag + 进程内 TTL 缓存）。 */
  loadStoryText?: () => Promise<string | null>
  loadGaps?: () => Promise<CoverageGaps | null>
  loadDossier?: () => Promise<StoryDossier | null>
  /** 一次性全新上下文 LLM 调用（缺省 chatForRag）。 */
  ask?: (messages: ChatMessage[], maxTokens: number) => Promise<string>
  /** 可选模型覆盖（铁律 1：-pro 变体拒绝——见 assertNonProModel）。缺省 = settings。 */
  model?: string
  /** 时钟（测试注入）。 */
  now?: () => number
  /** 定位命中缓存跳过时的原文读取（测试/报告用）。 */
  budget?: number
}

export interface VerifyOriginalResult {
  content: string
  meta: VerifyMeta
}

const ASK_SYSTEM =
  '你是剧本原文查证器——守密人（KP）的内部子代理，玩家看不到你的输出，你也不需要扮演或润色。' +
  '你会收到一部 COC 跑团模组剧本原文的若干片段（为检索而定位，可能不全、可能有省略）与一个具体问题。\n' +
  '规则：\n' +
  '1. 只依据所给原文片段回答，不得编造或脑补；不要在片段之外补充"常见设定"。\n' +
  '2. 所给片段里没有的信息 → found=false，answer 写「原文片段中未取得该信息」。\n' +
  '3. quote 必须是所给片段中逐字出现的原文摘录（≤80 字），found=false 时留空。\n' +
  '4. answer 用中文，≤200 字，直接给结论（NPC 名/地点/时间/数字要精确）。\n' +
  '只输出 JSON：{"answer":"…","quote":"…","found":true/false}'

/** 从可能截断的 JSON 文本里抠一个字段（推理模型常在 max_tokens 处截断输出）。 */
function extractJsonField(s: string, key: string): string {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?`)
  const m = s.match(re)
  if (!m || !m[1]) return ''
  return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').trim()
}

function parseAnswer(raw: string): { answer: string; quote: string; found: boolean } {
  const s = String(raw ?? '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const o = JSON.parse(s.slice(start, end + 1)) as { answer?: unknown; quote?: unknown; found?: unknown }
      const answer = typeof o.answer === 'string' ? o.answer.trim() : ''
      if (answer) {
        return { answer, quote: typeof o.quote === 'string' ? o.quote.trim() : '', found: o.found !== false }
      }
    } catch {
      /* JSON 被截断/畸形：走字段抠取，绝不把整段 JSON 当结论 */
    }
  }
  if (start >= 0) {
    const answer = extractJsonField(s, 'answer')
    if (answer) {
      return { answer, quote: extractJsonField(s, 'quote'), found: !/"found"\s*:\s*false/.test(s) }
    }
    // 无 answer 字段：JSON 前若有大段散文（模型写在 JSON 之前）→ 用散文
    const prose = s.slice(0, start).trim()
    if (prose.length >= 30) return { answer: prose, quote: '', found: true }
    // 只剩 JSON 骨架 → 视为未作答
    return { answer: '', quote: '', found: false }
  }
  return { answer: s, quote: '', found: true }
}

/** 默认原文读取：readStoryForRag + 进程内 TTL 缓存（PDF OCR 很贵，逐次读不可行）。 */
async function defaultLoadStoryText(userId: number, scriptId: string, now: () => number): Promise<string | null> {
  const key = `${userId}:${scriptId}`
  const hit = textCache.get(key)
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.text
  const raw = await readStoryForRag(userId, scriptId)
  const text = String(raw?.content ?? '')
  if (!text) return null
  if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value as string)
  textCache.set(key, { at: now(), text })
  return text
}

/**
 * 原文查证：定位窗口 → 全新上下文 LLM 作答 → 渲染结论（含剧透层标注）。
 * 永不抛出（LLM/IO 失败一律降级为「未取得」文本）。
 */
export async function verifyOriginal(
  input: { question: string; scene?: string },
  deps: VerifyOriginalDeps,
): Promise<VerifyOriginalResult> {
  const started = Date.now()
  const now = deps.now ?? (() => Date.now())
  const question = String(input?.question ?? '').trim()
  const scene = String(input?.scene ?? '').trim()
  try {
    assertNonProModel(deps.model)
  } catch (e) {
    return {
      content: renderUnavailable(`模型配置不受支持（${clip(e instanceof Error ? e.message : String(e), 80).text}）`),
      meta: { ok: false, tier: 'none', spoiler: 'normal', cached: false, chars: 0, reason: 'bad-model', durationMs: 0 },
    }
  }
  if (!question) {
    return {
      content: renderUnavailable('问题为空'),
      meta: { ok: false, tier: 'none', spoiler: 'normal', cached: false, chars: 0, reason: 'empty-question', durationMs: 0 },
    }
  }
  const cacheKey = `${deps.userId}:${deps.scriptId}:${scene}:${question}`
  const hit = answerCache.get(cacheKey)
  if (hit && now() - hit.at < CACHE_TTL_MS) {
    return { content: hit.content, meta: { ...hit.meta, cached: true, durationMs: Date.now() - started } }
  }

  let storyText: string | null = null
  try {
    storyText = deps.loadStoryText ? await deps.loadStoryText() : await defaultLoadStoryText(deps.userId, deps.scriptId, now)
  } catch {
    storyText = null
  }
  if (!storyText) {
    const content = renderUnavailable('剧本原文不可读')
    const meta: VerifyMeta = { ok: false, tier: 'none', spoiler: 'normal', cached: false, chars: 0, reason: 'no-story', durationMs: Date.now() - started }
    answerCache.set(cacheKey, { at: now(), content, meta })
    return { content, meta }
  }

  const [gaps, dossier] = await Promise.all([
    (deps.loadGaps ?? (() => loadGaps(deps.userId, deps.scriptId)))().catch(() => null),
    (deps.loadDossier ?? (() => loadDossier(deps.userId, deps.scriptId)))().catch(() => null),
  ])

  const loc = locateForQuestion(storyText, gaps, dossier, scene || undefined, question, deps.budget ?? DEFAULT_BUDGET)
  if (loc.tier === 'none' || !loc.text) {
    const content = renderUnavailable('原文中未定位到与问题相关的片段')
    const meta: VerifyMeta = {
      ok: false, tier: 'none', spoiler: 'normal', sceneId: loc.sceneId, sceneName: loc.sceneName,
      cached: false, chars: 0, reason: 'no-location', durationMs: Date.now() - started,
    }
    answerCache.set(cacheKey, { at: now(), content, meta })
    return { content, meta }
  }

  const spoiler = classifySpoiler(question, dossier, gaps, loc.windows)
  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `【剧本原文片段】\n${loc.text}\n\n【问题】${question}` },
  ]
  const ask = deps.ask ?? ((msgs: ChatMessage[], maxTokens: number) => chatForRag(deps.userId, { messages: msgs, temperature: 0, maxTokens, model: deps.model }).then((r) => r.content))

  let answer = ''
  let quote = ''
  let lastErr = ''
  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt++) {
    try {
      const raw = await ask(messages, ASK_MAX_TOKENS)
      const parsed = parseAnswer(raw)
      if (parsed.answer) {
        answer = parsed.answer
        quote = parsed.quote
        lastErr = ''
        break
      }
      lastErr = 'empty answer'
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    if (attempt < ASK_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, ASK_BACKOFF_MS))
  }
  if (!answer) {
    const content = renderUnavailable(`原文查证调用失败（${clip(lastErr || 'unknown', 60).text}）`)
    return {
      content,
      meta: {
        ok: false, tier: loc.tier, spoiler: spoiler.level, sceneId: loc.sceneId, sceneName: loc.sceneName,
        cached: false, chars: loc.chars, reason: 'llm-error', spoilerReason: spoiler.reason, durationMs: Date.now() - started,
      },
    }
  }

  const content = renderVerifyContent({ answer, quote, sceneName: loc.sceneName, spoiler: spoiler.level })
  const meta: VerifyMeta = {
    ok: true, tier: loc.tier, spoiler: spoiler.level, sceneId: loc.sceneId, sceneName: loc.sceneName,
    cached: false, chars: loc.chars, spoilerReason: spoiler.reason, durationMs: Date.now() - started,
  }
  if (answerCache.size >= ANSWER_CACHE_MAX) answerCache.delete(answerCache.keys().next().value as string)
  answerCache.set(cacheKey, { at: now(), content, meta })
  return { content, meta }
}

/**
 * 模型守卫（铁律 1）：本工具不接受 model 参数（走 settings），但脚本/调用方若
 * 传入模型名，一律拒绝 -pro 变体（mimo-v2.5-pro 无视觉/上游 404 已知）。
 */
export function assertNonProModel(model: string | undefined): string | undefined {
  const m = String(model ?? '').trim()
  if (!m) return undefined
  if (/-pro\b|-pro$/i.test(m)) {
    throw new BadRequestError(`原文查证不接受 -pro 模型（mimo-v2.5-pro 不受支持）——当前 model=${m}`)
  }
  return m
}
