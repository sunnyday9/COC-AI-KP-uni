/**
 * 检索 query 构造与低分改写（M1-T4 / issue #47，spec #44 / ADR-0007 决策 6）。
 *
 * 触发形态是**每回合固定检索**（P26/P27 已证 KP 不会主动索取），所以 query 质量
 * 直接决定注入纹理的相关性。默认 query = 当前场景名 + 玩家合并发言（剥 `【玩家名】`
 * 前缀与行动壳）；**只在检索最高分低于阈值时**做一次 LLM 改写并重检一次——把
 * 改写成本从"每回合"压到"少见的低分回合"（ADR-0007 被否决方案 d）。
 *
 * 三条边界：
 *  - 改写**只影响检索用 query**，不进入对话内容、不改写玩家发言；
 *  - 改写**至多一次**，重检**至多一次**，改写后分更低则**回退原结果**（重检不倒退）；
 *  - 任何失败（改写抛错/超时/空答、检索抛错）→ 降级返回已有结果，**绝不抛出**。
 *
 * 纯函数 + 注入缝：`buildSceneQuery`/`cleanPlayerText`/`shouldRewrite` 无 IO；
 * `retrieveWithRewrite` 的检索与改写都从参数注入，单测不触网不落盘。
 */
import { chatForRag } from '../services/aiService.js'
import { assertNonProModel } from './modelGuard.js'
import type { ChatMessage } from '../services/llm/types.js'

/** 低分改写阈值（余弦相似度口径，越大越相关）。 */
export const DEFAULT_REWRITE_THRESHOLD = 0.35
/** 玩家文本进 query 的字符上限（query 只用于检索，不进上下文）。 */
export const DEFAULT_MAX_PLAYER_CHARS = 180
/** 改写单次等待上限（毫秒）；超时即回退原结果，不阻断回合。 */
export const DEFAULT_REWRITE_TIMEOUT_MS = 8_000
/** 清洗后仍短于该长度的片段视为纯噪声（剥掉）。 */
const MIN_PLAYER_CHARS = 2

/** 检索候选：`score` 为**相关性分**（越大越相关，不是距离）。 */
export interface ScoredChunk {
  id: string
  score: number
  content?: string
}

/** 改写器（注入缝）：原 query → 改写后的检索 query；抛错/返回空 = 失败。 */
export type RewriteFn = (query: string, sceneName: string) => Promise<string>

export interface SceneQuery {
  /** 检索用 query 文本。 */
  text: string
  /** 是否用上了玩家文本（false = 退化为纯场景名）。 */
  usedPlayerText: boolean
}

export interface BuildSceneQueryInput {
  sceneName?: string
  /** 本回合玩家合并发言原文（可含 `【玩家名】` 前缀、多行）。 */
  playerText?: string
  /** 玩家文本截断上限，缺省 DEFAULT_MAX_PLAYER_CHARS。 */
  maxPlayerChars?: number
}

/* ═══════════════════ 清洗（纯函数） ═══════════════════ */

/** `【…】` 前缀（行首，可多个）：玩家名标签 / 点数 / 骰子等中缀元数据。 */
const TAG_ANY = /【[^】]*】/g
/** 行动壳（句首意图标记——"我想/我要/我尝试…"不携带检索信息）。
 *  ⚠️ 代词只在**带后续动词短语**时才剥壳：裸 `我/你/他/她` 会吃掉「我们/他们/她的」
 *  的字头（`我们决定推开门` → `们决定推开门`），故加否定前瞻排除复数/助词。 */
const ACTION_SHELL = /^(?:我想要|我想去|我想|我要去|我要|我打算|我准备|我试图|我尝试|我去|我來|我来|让我|[我你他她](?!们|的|是|在|有|会|能|想|要|去|把|被|和|跟))/
/** 过渡词/对话填充（句首，逐层剥）。 */
const TRANSITION = /^(?:那么|然后|接着|于是|所以|不过|而且|另外|顺便|对了|嗯|哦|额|那个|这个)/
/** 连续重复标点/符号折叠为单个（情绪壳不进检索词）。 */
const REPEAT_RUN = /([，。！？；：、,.!?;:…—～~“”"'（）()【】])\1+/g
/** 句尾标点串（情绪壳：`门开了？？？` → `门开了`；句中标点保留，仍起切分作用）。 */
const TRAILING_PUNCT = /[，。！？；：、,.!?;:…—～~\s]+$/

/**
 * 玩家发言清洗（纯函数）：剥 `【玩家名】` 前缀与中缀元数据、行动壳、过渡词，
 * 折叠重复标点与空白。目标只有一个——**留下可供检索的语义内容**；清洗结果
 * 只用于检索，绝不回写对话。
 */
export function cleanPlayerText(raw: string | undefined, maxChars = DEFAULT_MAX_PLAYER_CHARS): string {
  const lines = String(raw ?? '').split('\n')
  const parts: string[] = []
  for (const line of lines) {
    let s = line.trim()
    if (!s) continue
    s = s.replace(TAG_ANY, ' ')
    s = s.replace(REPEAT_RUN, '$1')
    s = s.replace(/\s+/g, ' ').trim()
    // 行动壳/过渡词逐层剥（最多 3 层，避免吃掉有信息的前缀）
    for (let i = 0; i < 3; i++) {
      const before = s
      s = s.replace(TRANSITION, '').replace(ACTION_SHELL, '').trim()
      s = s.replace(/^[，。！？；：、,.!?;:…—～~\s]+/, '').trim()
      if (s === before) break
    }
    s = s.replace(TRAILING_PUNCT, '').trim()
    if (s.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_PLAYER_CHARS) continue
    parts.push(s)
  }
  const joined = parts.join(' ').trim()
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_PLAYER_CHARS
  return joined.length > cap ? joined.slice(0, cap).trim() : joined
}

/**
 * 默认 query 构造（纯函数）：场景名 + 清洗后的玩家文本。
 * 无玩家文本（开局/纯符号壳）→ 退化为纯场景名；两者都空 → 空串（调用方跳过检索）。
 */
export function buildSceneQuery(input: BuildSceneQueryInput): SceneQuery {
  const sceneName = String(input?.sceneName ?? '').trim()
  const player = cleanPlayerText(input?.playerText, input?.maxPlayerChars ?? DEFAULT_MAX_PLAYER_CHARS)
  const parts = [sceneName, player].filter((p) => p.length > 0)
  return { text: parts.join(' '), usedPlayerText: player.length > 0 }
}

/* ═══════════════════ 低分改写 ═══════════════════ */

/**
 * 候选最高分（空候选 → 0）。
 *
 * 初值取 -Infinity 而不是 0：余弦相似度可为负（无关/反向块），从 0 起算会把
 * 全负候选的 topScore 一律报成 0，从而让「改写后更差就回退」的守卫失效
 * （审查发现的采纳漏洞）。
 */
export function topScoreOf(chunks: ScoredChunk[] | null | undefined): number {
  let best = Number.NEGATIVE_INFINITY
  for (const c of Array.isArray(chunks) ? chunks : []) {
    const s = Number(c?.score)
    if (Number.isFinite(s) && s > best) best = s
  }
  return Number.isFinite(best) ? best : 0
}

/**
 * 是否需要改写：最高分**严格低于**阈值才改写；空候选不改写
 * （无分可低——检索没返回东西是索引问题，改写 query 白花一次 LLM）。
 */
export function shouldRewrite(
  chunks: ScoredChunk[] | null | undefined,
  threshold = DEFAULT_REWRITE_THRESHOLD,
): boolean {
  const list = Array.isArray(chunks) ? chunks : []
  if (list.length === 0) return false
  return topScoreOf(list) < threshold
}

/* ═══════════════════ 改写器（默认实现 = 一次 LLM 调用） ═══════════════════ */

const REWRITE_SYSTEM =
  '你是剧本检索查询改写器。输入是一条用于「向量检索剧本原文片段」的查询，' +
  '它由场景名与玩家（调查员）的发言拼接而成——发言里有口语、行动描述与情绪，' +
  '直白口语会拉低检索命中率。\n' +
  '把它改写为**更贴近剧本原文措辞**的检索查询：\n' +
  '1. 保留场景名与其中的人名/地名/物件名（专有名词逐字保留，不得替换）。\n' +
  '2. 把口语动作改写为原文可能使用的描写性名词/短语（如「看看这里」→「环境 陈设 光线」）。\n' +
  '3. 只输出查询本身：一行、不超过 40 字、不含引号/编号/解释/标点修饰。'

/** 改写输出清洗：单行、去引号/编号/前缀标签、截断。 */
export function sanitizeRewrite(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  s = (s.split('\n').find((l) => l.trim().length > 0) ?? '').trim()
  // 编号/前缀标签先剥，再剥引号——顺序不能反：`1. 「查询」` 先剥引号会被编号挡住，
  // 结果残留一对引号（审查前实测）。
  for (let i = 0; i < 2; i++) {
    const before = s
    s = s.replace(/^\d+[.、)]\s*/, '').trim()
    s = s.replace(/^(?:改写后|改写|查询|检索|query|rewritten)\s*[:：]\s*/i, '').trim()
    s = s.replace(/^["'“”「」『』【】]+|["'“”「」『』【】]+$/g, '').trim()
    if (s === before) break
  }
  s = s.replace(/\s+/g, ' ')
  return s.length > 80 ? s.slice(0, 80).trim() : s
}

export interface RewriteQueryDeps {
  userId: number
  /** 模型覆盖（铁律 1：拒绝 -pro 变体；缺省走 settings）。 */
  model?: string
  /** 直接注入 LLM（测试用）；缺省 chatForRag。 */
  llm?: (messages: ChatMessage[], maxTokens: number) => Promise<string>
  maxTokens?: number
}

/** 默认改写：一次全新上下文的 LLM 调用（只回答改写后的查询）。 */
export async function rewriteQuery(
  query: string,
  sceneName: string,
  deps: RewriteQueryDeps,
): Promise<string> {
  assertNonProModel(deps.model)
  const llm =
    deps.llm ??
    ((messages: ChatMessage[], maxTokens: number) =>
      chatForRag(deps.userId, { messages, temperature: 0, maxTokens, model: deps.model }).then((r) => r.content))
  const messages: ChatMessage[] = [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: `【场景】${sceneName || '（未知）'}\n【查询】${query}` },
  ]
  const raw = await llm(messages, deps.maxTokens ?? 200)
  return sanitizeRewrite(raw)
}

/* ═══════════════════ 检索 + 至多一次改写重检 ═══════════════════ */

export interface RetrieveWithRewriteInput<T extends ScoredChunk = ScoredChunk> {
  query: string
  /** 检索（已绑定 scriptId/topK：传 query 返回候选，**相关性分越大越相关**）。
   *  泛型保留调用方的候选附加字段（如块偏移 `start`——装配层做场景归属要用）。 */
  retrieve: (query: string) => Promise<T[]>
  /** 改写器；缺省 = 不改写（M1 开关关闭 / 无 LLM 时的降级形态）。 */
  rewrite?: RewriteFn
  threshold?: number
  /** 场景名（传给改写器当锚定信息）。 */
  sceneName?: string
  /** 改写等待上限（毫秒），缺省 DEFAULT_REWRITE_TIMEOUT_MS。 */
  timeoutMs?: number
  /** 时钟（测试注入）。 */
  now?: () => number
}

export interface RetrievalResult<T extends ScoredChunk = ScoredChunk> {
  /** 最终采用的 query（改写被采纳时为改写后的文本）。 */
  query: string
  chunks: T[]
  topScore: number
  /** 是否采纳了改写结果。 */
  rewritten: boolean
  /** 降级原因（检索失败 / 改写失败），无 = undefined。 */
  error?: string
  durationMs: number
}

/** 一次检索：失败降级为空候选（回合不因检索中断）。 */
async function safeRetrieve<T extends ScoredChunk>(
  retrieve: (query: string) => Promise<T[]>,
  query: string,
): Promise<{ chunks: T[]; error?: string }> {
  try {
    const chunks = await retrieve(query)
    return { chunks: Array.isArray(chunks) ? chunks : [] }
  } catch (e) {
    return { chunks: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 检索，并在最高分低于阈值时做**至多一次** LLM 改写 + 重检一次。
 *
 * 采纳规则：改写成功且重检最高分**不低于**原结果 → 用新结果（等价时也换，
 * 视为改写无害）；否则回退原 query 的结果——低分改写不该让检索变差。
 * 永不抛出。
 */
export async function retrieveWithRewrite<T extends ScoredChunk = ScoredChunk>(
  input: RetrieveWithRewriteInput<T>,
): Promise<RetrievalResult<T>> {
  const now = input?.now ?? (() => Date.now())
  const started = now()
  const query = String(input?.query ?? '').trim()
  const threshold = Number.isFinite(input?.threshold) ? (input.threshold as number) : DEFAULT_REWRITE_THRESHOLD
  const done = (r: Omit<RetrievalResult<T>, 'durationMs'>): RetrievalResult<T> => ({ ...r, durationMs: now() - started })

  if (!query || typeof input?.retrieve !== 'function') {
    return done({ query, chunks: [], topScore: 0, rewritten: false })
  }

  const first = await safeRetrieve(input.retrieve, query)
  const failed = done({
    query,
    chunks: first.chunks,
    topScore: topScoreOf(first.chunks),
    rewritten: false,
    error: first.error,
  })
  // 检索失败 / 未注入改写器 / 分数够高 → 不做改写
  if (first.error || !input.rewrite || !shouldRewrite(first.chunks, threshold)) return failed

  const timeoutMs = Number.isFinite(input.timeoutMs) && (input.timeoutMs as number) > 0
    ? (input.timeoutMs as number)
    : DEFAULT_REWRITE_TIMEOUT_MS
  let timer: NodeJS.Timeout | null = null
  let timedOut = false
  let newQuery = ''
  try {
    newQuery = await Promise.race([
      Promise.resolve()
        .then(() => (input.rewrite as RewriteFn)(query, String(input.sceneName ?? '')))
        .then((r) => String(r ?? '').trim()),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve('')
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } catch (e) {
    return done({
      query,
      chunks: first.chunks,
      topScore: topScoreOf(first.chunks),
      rewritten: false,
      error: e instanceof Error ? e.message : String(e),
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
  // 超时/空答/与原文相同 → 回退原结果（同 query 重检没有意义；改写器原样回吐也算失败）
  if (timedOut || !newQuery || newQuery === query) {
    return done({
      query,
      chunks: first.chunks,
      topScore: topScoreOf(first.chunks),
      rewritten: false,
      error: timedOut
        ? `rewrite timeout after ${timeoutMs}ms`
        : newQuery
          ? 'rewrite returned the query unchanged'
          : 'rewrite returned empty',
    })
  }

  const second = await safeRetrieve(input.retrieve, newQuery)
  const newTop = topScoreOf(second.chunks)
  const firstTop = topScoreOf(first.chunks)
  // 采纳条件：重检没出错、有条目、且分数不倒退。空结果一律拒绝——改写把检索打成
  // 空候选是明确的倒退（审查：负分/零分候选下这条守卫曾被 topScoreOf 的 0 初值绕过）。
  if (second.error || second.chunks.length === 0 || newTop < firstTop) {
    return done({
      query,
      chunks: first.chunks,
      topScore: firstTop,
      rewritten: false,
      error: second.error,
    })
  }
  return done({ query: newQuery, chunks: second.chunks, topScore: newTop, rewritten: true })
}

/** 模型守卫复述（铁律 1）：本模块不接受 -pro 变体。 */
export function assertQueryBuildModel(model: string | undefined): string | undefined {
  return assertNonProModel(model, '检索 query 改写')
}
