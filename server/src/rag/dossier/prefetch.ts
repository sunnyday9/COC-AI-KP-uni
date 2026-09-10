/**
 * 服务端「原文查证」自动预取（P27，实验分支 feature/kp-dossier-workflow）。
 *
 * P26 的负结论：把"档案可能不全""事实问先查证"写进提示词、并把覆盖率数字摆到
 * KP 眼前之后，KP 仍不调用 verify_original（40 个 dossier 游玩回合合计 1 次）——
 * 它偏好换用查档案工具，或在档案残缺时直接凭印象叙事。因此触发改由**服务端**
 * 负责：判定（纯函数）→ 预取一次查证 → 结论并入本轮 system 上下文
 * （`## 原文查证` 块，对玩家不可见），不再依赖 KP 自觉。
 *
 * 判定（全部条件成立才触发，宁缺勿滥——每次触发都是一次 LLM 调用 + 20–40s）：
 *   1. 玩家发言是**事实问句**（问号/疑问词，且长度达标）；
 *   2. 当前场景档案**对不上问题措辞**（问题 CJK 二元组在档案块中的命中率 < 阈值），
 *      或压根没有场景块（房间场景未匹配档案）；
 *   3. 场景覆盖度未达"足够"线（≥ 阈值且已知缺口时说明档案基本完整，问题多半
 *      不在剧本里，不值得花一次调用——由 KP 按常识/行动推进）。
 *
 * 降级（与 verify_original 同精神，永不阻断回合）：不触发 / 查证失败 / 超时 /
 * 抛错 → 返回 null，调用方按"没有预取"继续。
 *
 * 缓存：verify_original 自带同问同场景的进程内 TTL 缓存，重复问题不再花调用。
 */
import { verifyOriginal, type VerifyOriginalResult, type VerifyOriginalDeps } from './originalLookup.js'
import type { SceneCoverage } from './coverageGaps.js'

/** 事实问句信号：问号或疑问词（与 kpGraph 的意图词表面向一致）。 */
export const PRE_FACT_QUESTION = /[？?]|什么|谁|哪里|哪儿|哪一?个|哪些|何时|什么时候|多久|几点|多少|为什么|为何|怎么|如何|是否|吗|呢/
/** 以陈述句收尾标点结尾 → 视为行动叙述而非问句（玩家不写标点时要靠它兜底：
 *  「打听这里到底发生了什么。」是叙述，「海哥本名是什么」是提问）。 */
const PRE_DECLARATIVE_END = /[。！!…]\.?$/
/** 低于该长度不判问句（"谁？"这类碎片不触发）。 */
export const PRE_MIN_TEXT_CHARS = 6
/** 问题二元组在档案块中的命中率低于此值视为"档案对不上问题"。 */
export const PRE_OVERLAP_RATIO = 0.5
/** 问题二元组少于该数量视为信息量不足，不触发。 */
export const PRE_MIN_BIGRAMS = 3
/** 场景覆盖率 ≥ 此值（且已知）时不再预取：档案基本完整，问题多半不在剧本里。 */
export const PRE_COVERAGE_SUFFICIENT = 85
/** 预取默认超时（毫秒）：超时按"未取得"处理，不回填、不阻断回合。 */
export const PRE_TIMEOUT_MS = 90_000

export interface PrefetchInput {
  /** 本轮玩家发言（多人局 = 已合并的批次文本）。 */
  playerText: string
  /** 当前注入的场景档案块（空 = 房间场景未匹配到档案）。 */
  sceneBlock: string
  /** 当前场景名（作为查证的场景定位提示）。 */
  sceneName?: string
  /** 当前场景覆盖度（gap 归属；缺省/无锚 → null）。 */
  coverage?: SceneCoverage | null
}

export interface PrefetchDecision {
  trigger: boolean
  reason: 'dossier-miss' | 'no-scene-block' | 'dossier-covers' | 'coverage-sufficient' | 'not-a-question' | 'too-short' | 'low-signal'
  /** 触发时的查证问题（原文 = 玩家发言，去掉首尾空白）。 */
  question?: string
  /** 问题二元组在档案块中的命中率（诊断用）。 */
  overlap?: number
}

/** CJK 二元组集合（与 originalLookup.questionScore 同口径）。 */
function cjkBigrams(text: string): Set<string> {
  const cjk = String(text ?? '').replace(/[^\u4e00-\u9fff]/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  return out
}

/** 问题措辞在档案块中的命中率（0–1）；档案为空 → 0。 */
export function questionOverlap(question: string, sceneBlock: string): number {
  const grams = cjkBigrams(question)
  if (grams.size === 0) return 0
  const body = String(sceneBlock ?? '').replace(/[^\u4e00-\u9fff]/g, '')
  let hit = 0
  for (const g of grams) if (body.includes(g)) hit++
  return hit / grams.size
}

/** 触发判定（纯函数，无 IO）。 */
export function decidePrefetch(input: PrefetchInput): PrefetchDecision {
  const text = String(input.playerText ?? '').trim()
  if (text.length < PRE_MIN_TEXT_CHARS) return { trigger: false, reason: 'too-short' }
  // 陈述句收尾（。！…）且不是问号收尾 → 行动叙述，不是提问
  if (PRE_DECLARATIVE_END.test(text) && !/[？?]\s*$/.test(text)) return { trigger: false, reason: 'not-a-question' }
  if (!PRE_FACT_QUESTION.test(text)) return { trigger: false, reason: 'not-a-question' }
  if (cjkBigrams(text).size < PRE_MIN_BIGRAMS) return { trigger: false, reason: 'low-signal' }

  const sceneBlock = String(input.sceneBlock ?? '').trim()
  if (!sceneBlock) return { trigger: true, reason: 'no-scene-block', question: text }

  const overlap = questionOverlap(text, sceneBlock)
  if (overlap >= PRE_OVERLAP_RATIO) return { trigger: false, reason: 'dossier-covers', overlap }

  const cov = input.coverage
  if (cov && cov.gapCount > 0 && cov.coveragePct >= PRE_COVERAGE_SUFFICIENT) {
    return { trigger: false, reason: 'coverage-sufficient', overlap }
  }
  return { trigger: true, reason: 'dossier-miss', question: text, overlap }
}

export interface PrefetchDeps {
  userId: number
  scriptId: string
  /** 查证执行（缺省 verifyOriginal；测试注入）。 */
  verify?: (input: { question: string; scene?: string }, deps: VerifyOriginalDeps) => Promise<VerifyOriginalResult>
  /** 诊断事件（日志/报告；回调抛错被吞，不影响主流程）。 */
  onEvent?: (event: Record<string, unknown>) => void
  timeoutMs?: number
}

/**
 * 判定 + 预取。返回 null = 不注入（未触发 / 查证未取得 / 超时 / 出错）。
 * 返回结果里的 content 已含剧透层标注（verify_original 自身口径）。
 */
export async function runPrefetch(input: PrefetchInput, deps: PrefetchDeps): Promise<VerifyOriginalResult | null> {
  const decision = decidePrefetch(input)
  const emit = (event: Record<string, unknown>) => {
    try {
      deps.onEvent?.(event)
    } catch {
      /* 诊断不影响主流程 */
    }
  }
  emit({ type: 'prefetch-decision', trigger: decision.trigger, reason: decision.reason, overlap: decision.overlap, scene: input.sceneName })

  if (!decision.trigger || !decision.question) return null
  const verify = deps.verify ?? verifyOriginal
  const timeoutMs = deps.timeoutMs ?? PRE_TIMEOUT_MS
  const started = Date.now()
  try {
    const result = await Promise.race([
      verify({ question: decision.question, scene: input.sceneName }, { userId: deps.userId, scriptId: deps.scriptId }),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), timeoutMs)
        t.unref?.()
      }),
    ])
    if (!result || !result.meta.ok) {
      emit({ type: 'prefetch-result', ok: false, reason: result?.meta.reason ?? 'timeout', ms: Date.now() - started })
      return null
    }
    emit({ type: 'prefetch-result', ok: true, tier: result.meta.tier, spoiler: result.meta.spoiler, chars: result.meta.chars, ms: Date.now() - started })
    return result
  } catch (e) {
    emit({ type: 'prefetch-result', ok: false, reason: e instanceof Error ? e.message : String(e), ms: Date.now() - started })
    return null
  }
}
