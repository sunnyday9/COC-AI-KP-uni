/**
 * 检索补充层：检索编排 + 注入装配（M1-T5 / issue #49，spec #44 / ADR-0007 决策 2/5/8）。
 *
 * 两半分工明确：
 *  - `retrieveSupplement`（有 IO，注入缝）= query → 向量 top10 → 本地 cross-encoder
 *    重排 top3；重排器不可用 → 余弦 top3 + `degraded=true`（绝不阻断回合）；
 *  - `assembleSupplement`（**纯函数**）= 候选块 + 场景归属 + 档案 → 注入小节，
 *    含**剧透硬闸**、档案重叠剔除、场景内优先排序、跨场景 ≤1 条加前缀、1.6k 预算截断。
 *
 * 三道闸门的顺序（不能换）：先丢剧透块（安全优先，绝不因预算/排序把它带回来），
 * 再剔档案重复，最后排序 + 截断。预算截断在装配层一次完成——P25 教训：注入膨胀会
 * 吃掉档案房的 TTFT 优势，靠渲染层事后裁剪会留下"以为注入了其实没注入"的账。
 *
 * 分值是**相关性**（越大越相关）；`vectorStore.queryChunks` 返回的是 `distance = 1 - score`，
 * 接缝处已取反（见 `defaultRetrieve`）。
 */
import {
  attributeChunks,
  type Attribution,
} from './sceneAttribution.js'
import { SCENE_REGION_LEAD, SCENE_REGION_SPAN, normalizeText } from './dossier/regions.js'
import type { CoverageGaps } from './dossier/coverageGaps.js'
import { findScene } from './dossier/sceneLookup.js'
import type { StoryDossier } from './dossier/schema.js'

/** 补充小节标题（spec 固定文案，客户端/测试按字面断言）。 */
export const SUPPLEMENT_HEADING = '## 原文片段（检索补充·仅作描写素材）'
/** 注入字符预算（硬约束：≤1.6k 字符，含标题与全部修饰）。 */
export const SUPPLEMENT_BUDGET_CHARS = 1_600
/** 至多注入条数。 */
export const MAX_SUPPLEMENT_CHUNKS = 3
/** 跨场景块至多注入条数（ADR-0007 决策 5）。 */
export const MAX_CROSS_SCENE_CHUNKS = 1
/** 跨场景块前缀（不得向玩家揭示未来场景）。 */
export const CROSS_SCENE_PREFIX = '（未来场景片段·仅作描写素材，不得向玩家揭示）'
/** 与档案场景文本的重叠比例达到该值即剔除（档案已有，不必重复喂）。 */
export const OVERLAP_DROP_RATIO = 0.6
/** 重叠判定窗口长度（字符）——短块整体比对，长块抽样比对。 */
export const OVERLAP_WINDOW = 40
/** 向量检索候选数（重排前的召回量）。 */
export const DEFAULT_RECALL_TOP_K = 10
/** 重排后注入条数。 */
export const DEFAULT_RERANK_TOP_N = MAX_SUPPLEMENT_CHUNKS

/** 候选块（检索产物）。`score` = 相关性，越大越相关。 */
export interface SupplementCandidate {
  id: string
  content: string
  /** 原文起始偏移（场景归属与剧透闸的判据）。 */
  start: number
  score: number
}

export type AttributionKind = 'single' | 'cross' | 'none'

/**
 * 装配模式（两个消费方语义不同，共用检索但闸门不同）：
 *  - `supplement`（缺省）= **档案房的纹理补充**：档案块已在上下文里，所以要走
 *    "与档案重叠剔除""场景内优先""跨场景 ≤1 条 + 前缀"这套档案感知的闸门；
 *  - `plain` = **rag 房的标准情报块**：没有档案块，档案感知的闸门会**删掉它唯一的知识来源**
 *    （档案 sceneText 本就是原文誊抄，与检索块天然高重合 → 全被当重复剔除），
 *    且其场景名来自 KP 自由命名、与档案锚点常不匹配（全判"场景外"→ 塌成 1 条）。
 *    因此 plain 只做"相关性排序 + 条数/预算截断 + 剧透硬闸"，不做归属相关处理。
 *    剧透硬闸（revealScene 相交即丢）两模式都保留——安全项不因模式让步。
 */
export type AssembleMode = 'supplement' | 'plain'

export interface SupplementBlock {
  id: string
  text: string
  score: number
  /** 场景归属原始判定（T4 口径：single/cross/none）。 */
  attribution: AttributionKind
  /** 归属场景（single 时 1 个；cross 时 ≥2 个；none 为空）。 */
  scenes: { id: string; name: string }[]
  /** 是否"当前场景之外"的块（跨区域，或归属别的场景）——受跨场景限额与前缀约束。
   *  `plain` 模式恒为 false（该模式不做归属判断）。 */
  crossScene: boolean
}

export interface AssembleInput {
  candidates: SupplementCandidate[] | null
  gaps: CoverageGaps | null
  dossier: StoryDossier | null
  /** 当前场景（id 或名字；空 = 无当前场景，不做"场景内优先"）。 */
  currentScene?: string
  /** 总开关（缺省开）。关闭 → 空小节。 */
  enabled?: boolean
  /** 装配模式（缺省 supplement = 档案房纹理补充；plain = rag 房标准情报块）。 */
  mode?: AssembleMode
  budgetChars?: number
  maxChunks?: number
  maxCross?: number
}

export interface AssembleResult {
  /** 渲染好的小节（空串 = 不注入，调用方据此不追加任何内容）。 */
  section: string
  blocks: SupplementBlock[]
  chars: number
  /** 被剧透硬闸丢弃的条数（报告/诊断）。 */
  droppedSpoiler: number
  /** 被档案重叠剔除的条数。 */
  droppedOverlap: number
}

/* ═══════════════════ 纯函数：重叠判定 ═══════════════════ */

/**
 * 块与档案场景文本的逐字重叠比例（0–1）。
 * 用"块中出现在档案文本里的窗口占比"衡量——sceneText 是 LLM 从原文誊抄的，
 * 逐字窗口命中即代表该段档案已有。归一化去空白后比对（排版不敏感）。
 */
export function archiveOverlapRatio(chunkText: string, sceneText: string): number {
  const chunk = normalizeText(chunkText)
  const scene = normalizeText(sceneText)
  if (!chunk || !scene) return 0
  if (chunk.length <= OVERLAP_WINDOW) return scene.includes(chunk) ? 1 : 0
  const offsets: number[] = []
  for (let o = 0; o + OVERLAP_WINDOW <= chunk.length; o += OVERLAP_WINDOW) offsets.push(o)
  // 末尾不足一窗也要取样（否则长块尾部重复检测不到）
  const tail = chunk.length - OVERLAP_WINDOW
  if (offsets[offsets.length - 1] !== tail) offsets.push(tail)
  let hit = 0
  for (const o of offsets) if (scene.includes(chunk.slice(o, o + OVERLAP_WINDOW))) hit++
  return hit / offsets.length
}

/* ═══════════════════ 纯函数：剧透硬闸 ═══════════════════ */

/**
 * 收集"真相揭晓场景"的原文区域（[首锚点-LEAD, 末锚点+SPAN)）。
 * 与场景归属共用同一对常量（coverageGaps 的 SCENE_REGION_*）。
 */
export function revealRegions(
  gaps: CoverageGaps | null,
  dossier: StoryDossier | null,
): { start: number; end: number; sceneId: string; sceneName: string }[] {
  const out: { start: number; end: number; sceneId: string; sceneName: string }[] = []
  const anchors = Array.isArray(gaps?.sceneAnchors) ? (gaps as CoverageGaps).sceneAnchors : []
  for (const t of dossier?.truths ?? []) {
    const target = String(t?.revealScene ?? '').trim()
    if (!target) continue
    const scene = dossier ? findScene(dossier, target) : null
    const names = new Set([target.toLowerCase(), String(scene?.name ?? '').toLowerCase(), String(scene?.id ?? '').toLowerCase()].filter(Boolean))
    const anchor = anchors.find(
      (a) => names.has(String(a?.id ?? '').toLowerCase()) || names.has(String(a?.name ?? '').toLowerCase()),
    )
    if (!anchor?.matched) continue
    const starts = (Array.isArray(anchor.starts) ? anchor.starts : [])
      .filter((s) => typeof s === 'number' && Number.isFinite(s))
      .sort((x, y) => x - y)
    if (!starts.length) continue
    out.push({
      start: Math.max(0, (starts[0] as number) - SCENE_REGION_LEAD),
      end: (starts[starts.length - 1] as number) + SCENE_REGION_SPAN,
      sceneId: anchor.id,
      sceneName: anchor.name,
    })
  }
  return out
}

/** 块是否与任一揭晓区域相交（半开区间；零长块不判相交）。 */
function intersectsReveal(
  regions: { start: number; end: number }[],
  start: number,
  length: number,
): boolean {
  if (!Number.isFinite(start) || start < 0 || length <= 0) return false
  const end = start + length
  return regions.some((r) => start < r.end && end > r.start)
}

/** 块偏移是否可信（有限、非负）。不可信 = 无法判定它落在原文何处。 */
function hasOffset(start: number): boolean {
  return Number.isFinite(start) && start >= 0
}

/* ═══════════════════ 纯函数：装配 ═══════════════════ */

/**
 * 装配级分类：`in` = 当前场景内 → 优先；`none` = 无归属；`future` = 当前场景之外
 * （跨区域，或归属别的场景）。`future` 既受"至多 1 条"限额，也带未来场景前缀。
 *
 * 为什么把"归属别的场景"也算 future（而非只算 T4 的 cross）：M1 没有"已访问场景"
 * 台账，无法区分"后面才会到的场景"与"已经离开的场景"；对玩家而言两者都是"不在眼前
 * 的场景"，按 spec 的安全侧统一处理（限额 + 标注），代价只是少注入几条跨场景纹理。
 *
 * ⚠️ 为什么还要 `inSceneZone` 二次收窄（审查发现）：T4 的场景区域是
 * `[首锚点-LEAD, 末锚点+SPAN)`，SPAN=2500 有 2.5–8 个块宽——**属于下一场景的正文**
 * 常落在这个尾巴里，只按"区域交叠"判就会当成场景内块：不带前缀、不占跨场景名额。
 * 故装配只把"当前场景**末锚点**附近"算场景内（`inSceneZone`），其余一律按 future
 * 处理（限额 + 标注）。这是安全侧收窄：纹理少注入一点，好过把未来场景的描写
 * 当眼前景象喂给 KP。
 */
type Slot = 'in' | 'none' | 'future'

/** 当前场景"确属眼前"的偏移上界（末锚点 + LEAD）。 */
function inSceneUpperBound(currentId: string, gaps: CoverageGaps | null): number {
  const anchors = Array.isArray(gaps?.sceneAnchors) ? (gaps as CoverageGaps).sceneAnchors : []
  const anchor = anchors.find((a) => String(a?.id ?? '').toLowerCase() === currentId)
  const starts = Array.isArray(anchor?.starts)
    ? (anchor.starts as number[]).filter((s) => typeof s === 'number' && Number.isFinite(s))
    : []
  return starts.length ? Math.max(...starts) + SCENE_REGION_LEAD : Number.POSITIVE_INFINITY
}

function slotOf(att: Attribution, chunkStart: number, currentId: string, gaps: CoverageGaps | null): Slot {
  if (att.kind === 'cross') return 'future'
  if (att.kind === 'none') return 'none'
  if (!currentId) return 'future'
  if ((att.scenes[0]?.id ?? '').toLowerCase() !== currentId) return 'future'
  // 收窄：仅"末锚点附近"算眼前；信封尾巴（可能已是下一场景正文）按 future 处理
  if (!Number.isFinite(chunkStart)) return 'future'
  return chunkStart <= inSceneUpperBound(currentId, gaps) ? 'in' : 'future'
}

/** 排序权重：场景内 0 < 无归属 1 < 场景外 2（分数只在同权重内比较）。 */
function rankOf(slot: Slot): number {
  if (slot === 'in') return 0
  if (slot === 'none') return 1
  return 2
}

/**
 * 装配注入小节（纯函数，无 IO）。
 *
 * 流程：开关 → 丢空块 → **剧透硬闸** → 档案重叠剔除 → 内容去重 → 排序
 * （场景内 → 无归属 → 跨场景，同级按分数降序）→ 跨场景限额 → 逐条试放（整条放不下
 * 就跳过，不截断半句）→ 预算硬截断 → 渲染。
 */
export function assembleSupplement(input: AssembleInput): AssembleResult {
  const empty: AssembleResult = { section: '', blocks: [], chars: 0, droppedSpoiler: 0, droppedOverlap: 0 }
  if (input?.enabled === false) return empty
  const candidates = Array.isArray(input?.candidates) ? (input.candidates as SupplementCandidate[]) : []
  if (!candidates.length) return empty

  const gaps = input?.gaps ?? null
  const dossier = input?.dossier ?? null
  const current = String(input?.currentScene ?? '').trim()
  const plain = input?.mode === 'plain'
  const budget = Number.isFinite(input?.budgetChars) && (input?.budgetChars as number) > 0
    ? (input?.budgetChars as number)
    : SUPPLEMENT_BUDGET_CHARS
  const maxChunks = Number.isFinite(input?.maxChunks) && (input?.maxChunks as number) >= 0
    ? (input?.maxChunks as number)
    : MAX_SUPPLEMENT_CHUNKS
  const maxCross = Number.isFinite(input?.maxCross) && (input?.maxCross as number) >= 0
    ? (input?.maxCross as number)
    : MAX_CROSS_SCENE_CHUNKS

  // 归一化候选：丢空文本、纠正畸形分/偏移（保留 `content` 键——场景归属按 content 长度判交叠）
  const normalized = candidates
    .map((c) => ({
      id: String(c?.id ?? ''),
      content: String(c?.content ?? '').trim(),
      start: typeof c?.start === 'number' && Number.isFinite(c.start) ? c.start : Number.NaN,
      score: Number.isFinite(Number(c?.score)) ? Number(c.score) : 0,
    }))
    .filter((c) => c.content.length > 0)
  if (!normalized.length) return empty

  // 场景归属（查询期现算；用索引对齐原候选，过滤后仍一一对应）
  const attributions: Attribution[] = attributeChunks(gaps as CoverageGaps | null, normalized)

  // 当前场景 id（用档案把名字归一成 id，便于与归属 id 比对）
  const currentScene = dossier && current ? findScene(dossier, current) : null
  const currentId = String(currentScene?.id ?? current).toLowerCase()

  const regions = revealRegions(gaps, dossier)
  const scenes = Array.isArray(dossier?.scenes) ? (dossier as StoryDossier).scenes : []

  let droppedSpoiler = 0
  let droppedOverlap = 0
  /** 内容 → 已收下标的（重复内容只留分最高的一条）。 */
  const seen = new Map<string, number>()
  const kept: { block: SupplementBlock; slot: Slot; rank: number; order: number; key: string }[] = []

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i] as (typeof normalized)[number]
    const att = attributions[i] ?? { index: i, kind: 'none' as const, scenes: [] }

    // ① 剧透硬闸：与真相揭晓区域相交 → 直接丢弃（优先级最高，预算/排序无从豁免）。
    //    **fail closed**：存在揭晓区域但该块偏移不可信（旧索引无 start/NaN）时无法
    //    判定它是否落在揭晓区，此时一律丢弃而不是放行——否则一个丢偏移的旧索引就能
    //    整批绕过闸门（审查发现的失效方向）。
    if (regions.length > 0 && !hasOffset(c.start)) {
      droppedSpoiler++
      continue
    }
    if (intersectsReveal(regions, c.start, c.content.length)) {
      droppedSpoiler++
      continue
    }
    // ② 档案重叠：与该块所属场景的 sceneText 高度重合 → 档案已有，剔除。
    //    **仅 supplement 模式**：plain 模式（rag 房）没有档案块，这些块就是它全部的
    //    知识来源，按"档案已有"剔除会把 rag 房的内容清空（审查发现）。
    if (!plain) {
      const dup = att.scenes.some((s) => {
        const scene = scenes.find((x) => x.id === s.id)
        return scene ? archiveOverlapRatio(c.content, scene.sceneText ?? '') >= OVERLAP_DROP_RATIO : false
      })
      if (dup) {
        droppedOverlap++
        continue
      }
    }

    // plain 模式不做归属相关处理（无档案可依，场景名常与锚点不匹配）：全部按
    // "无归属"参与纯相关性排序，不占跨场景名额、不带前缀
    const slot: Slot = plain ? 'none' : slotOf(att, c.start, currentId, gaps)
    const block: SupplementBlock = {
      id: c.id,
      text: c.content,
      score: c.score,
      attribution: att.kind,
      scenes: att.scenes.map((s) => ({ id: s.id, name: s.name })),
      crossScene: slot === 'future',
    }
    // ③ 内容去重：同段原文只留分最高的一条（索引重叠会让相邻块内容重复），
    //    同分保留先到者（稳定）
    const key = normalizeText(c.content)
    const prev = seen.get(key)
    if (prev !== undefined) {
      const holder = kept[prev]
      if (holder && c.score > holder.block.score) {
        holder.block = block
        holder.slot = slot
        holder.rank = rankOf(slot)
        holder.order = i
      }
      continue
    }
    seen.set(key, kept.length)
    kept.push({ block, slot, rank: rankOf(slot), order: i, key })
  }

  // 排序：场景内 → 无归属 → 场景外；同级按分数降序（稳定：同分保持原序）
  kept.sort((a, b) => a.rank - b.rank || b.block.score - a.block.score || a.order - b.order)

  // 跨场景限额 + 条数限额 + 预算硬截断（整条试放，放不下就跳过）。
  // 限额在**预算判定之后**才计（审查）：被预算挡下的场景外块不该白烧掉那唯一名额。
  const picked: SupplementBlock[] = []
  let crossUsed = 0
  for (const k of kept) {
    if (picked.length >= maxChunks) break
    if (k.slot === 'future' && crossUsed >= maxCross) continue
    const trial = [...picked, k.block]
    if (renderSupplement(trial).length > budget) continue
    if (k.slot === 'future') crossUsed++
    picked.push(k.block)
  }

  const section = renderSupplement(picked)
  return {
    section,
    blocks: picked,
    chars: section.length,
    droppedSpoiler,
    droppedOverlap,
  }
}

/**
 * 渲染单块（纯函数）：跨场景块前置「未来场景片段」前缀，其余原样。
 * **消费方一律用这个**而不是裸取 `block.text`——前缀只在这里加，绕过它就等于
 * 把未来场景原文不带标注地喂给 KP（审查发现：rag 房曾直接 map(b => b.text)）。
 */
export function renderBlock(block: SupplementBlock): string {
  const text = String(block?.text ?? '').trim()
  if (!text) return ''
  return block.crossScene ? `${CROSS_SCENE_PREFIX}\n${text}` : text
}

/**
 * 渲染注入小节（纯函数）：标题 + 每条一段；跨场景条目前置前缀。
 * 无块 → 空串（调用方据此完全不注入）。
 */
export function renderSupplement(blocks: SupplementBlock[]): string {
  const list = Array.isArray(blocks) ? blocks.filter((b) => String(b?.text ?? '').trim().length > 0) : []
  if (!list.length) return ''
  return [SUPPLEMENT_HEADING, ...list.map(renderBlock)].join('\n')
}

/* ═══════════════════ 带 IO：检索编排（注入缝，可测） ═══════════════════ */

/** 向量检索（注入缝）：query → 候选（score = 相关性，越大越相关）。 */
export type RetrieveFn = (query: string) => Promise<SupplementCandidate[]>
/** 重排（注入缝）：返回候选下标与相关性分（顺序不限，本函数自行按分降序截断）；
 *  失败返回 null / 空数组 → 降级纯余弦（不阻断回合）。 */
export type RerankFn = (query: string, passages: string[]) => Promise<{ index: number; score: number }[] | null>

export interface RetrieveSupplementInput {
  query: string
  /** 向量召回（已绑定 scriptId 与召回条数；本函数不再二次截断召回集）。 */
  retrieve: RetrieveFn
  rerank?: RerankFn
  /** 重排后保留条数，缺省 DEFAULT_RERANK_TOP_N。 */
  topN?: number
}

export interface RetrieveSupplementResult {
  candidates: SupplementCandidate[]
  /** 是否走了降级路径（重排不可用 → 纯余弦）。 */
  degraded: boolean
  error?: string
}

/**
 * 检索编排：query → 向量候选（topK）→ 重排 topN。永不抛出。
 * 重排失败/未注入 → 余弦顺序截断 topN + `degraded=true`（error 带失败原因供排障）。
 */
export async function retrieveSupplement(input: RetrieveSupplementInput): Promise<RetrieveSupplementResult> {
  const query = String(input?.query ?? '').trim()
  const topN = Number.isFinite(input?.topN) && (input?.topN as number) > 0 ? (input?.topN as number) : DEFAULT_RERANK_TOP_N
  if (!query) return { candidates: [], degraded: false }
  if (typeof input?.retrieve !== 'function') return { candidates: [], degraded: false }

  let recalled: SupplementCandidate[]
  try {
    const raw = await input.retrieve(query)
    recalled = Array.isArray(raw) ? raw : []
  } catch (e) {
    return { candidates: [], degraded: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!recalled.length) return { candidates: [], degraded: false }

  // 重排：同步抛错也要接住（`Promise.resolve().then(...)` 把同步异常变成 rejection，
  // 否则注入方一个同步 throw 会穿透"永不抛出"的约定——审查发现）
  let rerankError = ''
  const ordered = typeof input.rerank === 'function'
    ? await Promise.resolve()
        .then(() => (input.rerank as RerankFn)(query, recalled.map((c) => String(c?.content ?? ''))))
        .catch((e) => {
          rerankError = e instanceof Error ? e.message : String(e)
          return null
        })
    : null
  if (!ordered || !ordered.length) {
    return { candidates: recalled.slice(0, topN), degraded: true, error: rerankError || undefined }
  }
  // 重排只做"打分"，排序/截断在这里做：不依赖注入方返回有序数组，也不信任其分数越界
  const ranked = ordered
    .filter((r) => Number.isFinite(Number(r?.index)))
    .map((r, i) => ({ index: Number(r.index), score: Number(r.score) || 0, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
  const picked: SupplementCandidate[] = []
  for (const r of ranked) {
    const c = recalled[r.index]
    if (c) picked.push({ ...c, score: r.score })
    if (picked.length >= topN) break
  }
  // 重排一条都没命中（下标全越界）→ 视同降级
  if (!picked.length) return { candidates: recalled.slice(0, topN), degraded: true }
  return { candidates: picked, degraded: false }
}
