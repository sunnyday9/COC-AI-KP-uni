/**
 * Dossier (剧本档案) types & parsing — the schema-compatible superset of the
 * structured COC script (`agent/scriptContext.ts` ScriptContext) that the
 * dossier generator produces from arbitrary story files (PDF/txt/md/…).
 *
 * Design: a dossier IS a ScriptContext plus free-text `sceneText` (the scene's
 * full narrative text, used for on-demand scene dossier lookup) and `meta`.
 * The LLM generation prompt (prompts.ts) emits this shape; `parseDossierJson`
 * is defensive (drops unknown/malformed entries) so a stray LLM token can
 * never crash the game path.
 */
import { parseScriptContent, type ScriptContext } from '../../agent/scriptContext.js'

/** A generated dossier: structured scenes/clues/npcs + per-scene source text. */
export interface StoryDossier {
  /** story file id this dossier was generated from (e.g. "demo-story.txt"). */
  scriptId: string
  storyName: string
  generatedAt: number
  /** LLM model id used for generation ('' when unknown). */
  generatedByModel?: string
  /** Structured layer — same shape as the COC script JSON schema. */
  scenes: DossierScene[]
  clues: DossierClue[]
  npcs: DossierNpc[]
  /** 图关系层 v2：场景间显式切换边（引用场景 id 或名字，运行时按名兜底解析）。 */
  transitions?: DossierTransition[]
  /** 图关系层 v2：剧本内事件时间线（数组顺序 = 剧情先后）。 */
  events?: DossierEvent[]
  /**
   * 真相层 v2.1：剧情幕后真相（剧透内容——运行时不得自动注入 KP 提示词；
   * 只服务结局裁定/查证工具/评估重建）。原文仍保留在场景 sceneText，这里只是结构化。
   */
  truths?: DossierTruth[]
  /** 结局层 v2.1：剧本明确写出的结局及达成条件（剧透内容，同上）。 */
  endings?: DossierEnding[]
  meta?: DossierMeta
  /** Free-text search index: term → weight (lightweight lexical fallback). */
  search?: Record<string, number>
}

export interface DossierMeta {
  title?: string
  ruleSystem?: string
  /** 故事发生的时间背景（如 "2024 年 4 月，宫城县近海猫岛"）。 */
  timeframe?: string
  /** 一句话开场钩子/委托由头（无剧透）。 */
  premise?: string
  /** 世界观/背景设定（无剧透，供 KP 理解世界而非泄底）。 */
  background?: string
}

export interface DossierScene {
  id: string
  name: string
  /** The scene's narrative text (from the story), used by scene_dossier lookup. */
  sceneText: string
  description?: string
  npcIds?: string[]
  clueIds?: string[]
  transitionCondition?: string
  requiredClues?: string[]
  /** Suggested intro/opening hooks the LLM can use when the party enters. */
  hooks?: string[]
  /** Raw story excerpts naming this scene (short). */
  keywords?: string[]
}

export interface DossierClue {
  id: string
  description: string
  obtainCondition?: string
  requiredClues?: string[]
  /** Where the clue is found (scene id or free text). */
  location?: string
}

/** 场景间切换边：from/to 引用场景 id 或名字（跨批生成时用名字，合并后按 id 归一化）。 */
export interface DossierTransition {
  id?: string
  from: string
  to: string
  /** 自然语言切换条件（何时/怎样可走这条边；可省略表示无门槛）。 */
  condition?: string
  /** 触发/解锁这条边所需的线索（id 或名字）。 */
  viaClues?: string[]
}

/** 剧本内事件（时间线条目）：数组顺序即剧情先后。引用场景/人物用 id 或名字。 */
export interface DossierEvent {
  id?: string
  /** 剧本内时间表述（如 "2 月 16 日夜"、"开场前十年"；无明确时间可省略）。 */
  when?: string
  /** 发生了什么（1-2 句）。 */
  summary: string
  /** 发生地（场景 id 或名字，可省略）。 */
  scene?: string
  /** 涉及人物（id 或名字，可省略）。 */
  npcs?: string[]
  /** 是否主线关键事件（推动真相/结局的不可省节点）。 */
  critical?: boolean
}

export interface DossierNpc {
  id: string
  name: string
  description?: string
  role?: string
  /** Story excerpts that describe this NPC. */
  details?: string
  /** 人物关系边（引用对方 npc 的 id 或名字）。 */
  relations?: DossierRelation[]
}

/** NPC 关系：target 引用对方 npc id 或名字（跨批用名字，合并后按 id 归一化）。 */
export interface DossierRelation {
  target: string
  /** 关系类型：亲属/同事/师生/恋人/敌对/仇人/秘密关联/上下级/其他。 */
  type: string
  /** 一句话说明（可省略）。 */
  note?: string
}

/** 剧情真相（剧透层）：事件真正的幕后因果/秘密。引用线索/场景用 id 或名字。 */
export interface DossierTruth {
  id?: string
  /** 短标题（如 "逐日工程引来星之彩"）。 */
  title: string
  /** 真相完整描述（2-4 句：幕后黑手/事件起因经过结果）。 */
  detail: string
  /** 支撑该真相的线索（玩家可凭它们拼出真相）。 */
  relatedClues?: string[]
  /** 玩家主要揭晓该真相的场景（id 或名字）。 */
  revealScene?: string
}

/** 剧本结局（剧透层）：结局名 + 达成条件 + 结果。 */
export interface DossierEnding {
  id?: string
  /** 结局名（好结局/坏结局/普通结局/团灭…）。 */
  name: string
  /** 达成条件（自然语言，可引用线索/行动/时间）。 */
  condition: string
  /** 结局发生后的事（玩家所见/世界变化，可省略）。 */
  outcome?: string
  /** 关联真相（id 或标题）。 */
  relatedTruths?: string[]
}

/** File name safe-id mapping: mirror vectorStore's sanitize rule. */
export function sanitizeScriptId(scriptId: string): string {
  return String(scriptId).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
}

/** Parse a generated dossier JSON string into a StoryDossier (null when invalid). */
export function parseDossierJson(raw: string): StoryDossier | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  const scenes: DossierScene[] = []
  if (Array.isArray(obj.scenes)) {
    for (const s of obj.scenes) {
      const sc = parseScene(s)
      if (sc) scenes.push(sc)
    }
  }
  const clues: DossierClue[] = []
  if (Array.isArray(obj.clues)) {
    for (const c of obj.clues) {
      const cl = parseClue(c)
      if (cl) clues.push(cl)
    }
  }
  const npcs: DossierNpc[] = []
  if (Array.isArray(obj.npcs)) {
    for (const n of obj.npcs) {
      const np = parseNpc(n)
      if (np) npcs.push(np)
    }
  }
  const transitions: DossierTransition[] = []
  if (Array.isArray(obj.transitions)) {
    for (const t of obj.transitions) {
      const tr = parseTransition(t)
      if (tr) transitions.push(tr)
    }
  }
  const events: DossierEvent[] = []
  if (Array.isArray(obj.events)) {
    for (const e of obj.events) {
      const ev = parseEvent(e)
      if (ev) events.push(ev)
    }
  }
  const truths: DossierTruth[] = []
  if (Array.isArray(obj.truths)) {
    for (const t of obj.truths) {
      const tr = parseTruth(t)
      if (tr) truths.push(tr)
    }
  }
  const endings: DossierEnding[] = []
  if (Array.isArray(obj.endings)) {
    for (const e of obj.endings) {
      const en = parseEnding(e)
      if (en) endings.push(en)
    }
  }
  if (scenes.length === 0 && clues.length === 0 && npcs.length === 0 && transitions.length === 0 && events.length === 0 && truths.length === 0 && endings.length === 0) return null
  const scriptId = typeof obj.scriptId === 'string' ? obj.scriptId : ''
  const storyName = typeof obj.storyName === 'string' ? obj.storyName : scriptId
  const meta = (obj.meta && typeof obj.meta === 'object') ? parseMeta(obj.meta) : undefined
  return {
    scriptId,
    storyName,
    generatedAt: typeof obj.generatedAt === 'number' ? obj.generatedAt : Date.now(),
    generatedByModel: typeof obj.generatedByModel === 'string' ? obj.generatedByModel : undefined,
    scenes,
    clues,
    npcs,
    transitions: transitions.length ? transitions : undefined,
    events: events.length ? events : undefined,
    truths: truths.length ? truths : undefined,
    endings: endings.length ? endings : undefined,
    meta,
    search: (obj.search && typeof obj.search === 'object') ? (obj.search as Record<string, number>) : undefined,
  }
}

function parseMeta(m: unknown): DossierMeta | undefined {
  if (typeof m !== 'object' || m === null) return undefined
  const o = m as Record<string, unknown>
  const out: DossierMeta = {}
  for (const k of ['title', 'ruleSystem', 'timeframe', 'premise', 'background']) {
    if (typeof o[k] === 'string' && o[k]) out[k as keyof DossierMeta] = o[k] as string
  }
  return Object.keys(out).length ? out : undefined
}

function parseScene(s: unknown): DossierScene | null {
  if (typeof s !== 'object' || s === null) return null
  const sc = s as Record<string, unknown>
  if (typeof sc.id !== 'string' && typeof sc.name !== 'string') return null
  const id = typeof sc.id === 'string' && sc.id ? sc.id : (typeof sc.name === 'string' ? sc.name : `scene_${Math.random().toString(36).slice(2, 8)}`)
  const name = typeof sc.name === 'string' && sc.name ? sc.name : id
  return {
    id,
    name,
    sceneText: typeof sc.sceneText === 'string' ? sc.sceneText : '',
    description: typeof sc.description === 'string' ? sc.description : undefined,
    npcIds: strArray(sc.npcIds),
    clueIds: strArray(sc.clueIds),
    transitionCondition: typeof sc.transitionCondition === 'string' ? sc.transitionCondition : undefined,
    requiredClues: strArray(sc.requiredClues),
    hooks: strArray(sc.hooks),
    keywords: strArray(sc.keywords),
  }
}

function parseClue(c: unknown): DossierClue | null {
  if (typeof c !== 'object' || c === null) return null
  const cl = c as Record<string, unknown>
  if (typeof cl.id !== 'string' && typeof cl.description !== 'string') return null
  const id = typeof cl.id === 'string' && cl.id ? cl.id : `clue_${Math.random().toString(36).slice(2, 8)}`
  const description = typeof cl.description === 'string' && cl.description ? cl.description : id
  return {
    id,
    description,
    obtainCondition: typeof cl.obtainCondition === 'string' ? cl.obtainCondition : undefined,
    requiredClues: strArray(cl.requiredClues),
    location: typeof cl.location === 'string' ? cl.location : undefined,
  }
}

function parseNpc(n: unknown): DossierNpc | null {
  if (typeof n !== 'object' || n === null) return null
  const np = n as Record<string, unknown>
  const name = typeof np.name === 'string' && np.name ? np.name : ''
  if (!name) return null
  const relations: DossierRelation[] = []
  if (Array.isArray(np.relations)) {
    for (const r of np.relations) {
      const rel = parseRelation(r)
      if (rel) relations.push(rel)
    }
  }
  return {
    id: typeof np.id === 'string' && np.id ? np.id : name,
    name,
    description: typeof np.description === 'string' ? np.description : undefined,
    role: typeof np.role === 'string' ? np.role : undefined,
    details: typeof np.details === 'string' ? np.details : undefined,
    relations: relations.length ? relations : undefined,
  }
}

function parseTransition(t: unknown): DossierTransition | null {
  if (typeof t !== 'object' || t === null) return null
  const o = t as Record<string, unknown>
  const from = typeof o.from === 'string' && o.from ? o.from : ''
  const to = typeof o.to === 'string' && o.to ? o.to : ''
  if (!from || !to) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : undefined,
    from,
    to,
    condition: typeof o.condition === 'string' && o.condition ? o.condition : undefined,
    viaClues: strArray(o.viaClues),
  }
}

function parseEvent(e: unknown): DossierEvent | null {
  if (typeof e !== 'object' || e === null) return null
  const o = e as Record<string, unknown>
  const summary = typeof o.summary === 'string' && o.summary ? o.summary : ''
  if (!summary) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : undefined,
    when: typeof o.when === 'string' && o.when ? o.when : undefined,
    summary,
    scene: typeof o.scene === 'string' && o.scene ? o.scene : undefined,
    npcs: strArray(o.npcs),
    critical: typeof o.critical === 'boolean' ? o.critical : undefined,
  }
}

function parseRelation(r: unknown): DossierRelation | null {
  if (typeof r !== 'object' || r === null) return null
  const o = r as Record<string, unknown>
  const target = typeof o.target === 'string' && o.target ? o.target : ''
  const type = typeof o.type === 'string' && o.type ? o.type : ''
  if (!target || !type) return null
  return {
    target,
    type,
    note: typeof o.note === 'string' && o.note ? o.note : undefined,
  }
}

function parseTruth(t: unknown): DossierTruth | null {
  if (typeof t !== 'object' || t === null) return null
  const o = t as Record<string, unknown>
  const title = typeof o.title === 'string' && o.title ? o.title : ''
  const detail = typeof o.detail === 'string' && o.detail ? o.detail : ''
  if (!title || !detail) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : undefined,
    title,
    detail,
    relatedClues: strArray(o.relatedClues),
    revealScene: typeof o.revealScene === 'string' && o.revealScene ? o.revealScene : undefined,
  }
}

function parseEnding(e: unknown): DossierEnding | null {
  if (typeof e !== 'object' || e === null) return null
  const o = e as Record<string, unknown>
  const name = typeof o.name === 'string' && o.name ? o.name : ''
  const condition = typeof o.condition === 'string' && o.condition ? o.condition : ''
  const outcome = typeof o.outcome === 'string' && o.outcome ? o.outcome : ''
  if (!name || !condition) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : undefined,
    name,
    condition,
    outcome,
    relatedTruths: strArray(o.relatedTruths),
  }
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && !!x)
  return out.length ? out : undefined
}

/**
 * Name→id reference normalization for the graph layer. Batched generation
 * references scenes/clues/npcs by NAME across batches (ids of other batches
 * are unknown); after merge, resolvable refs are rewritten to ids. Unresolved
 * refs stay as-is — runtime lookups (findScene & co.) match names too.
 */
export function resolveRefs(d: StoryDossier): StoryDossier {
  const sceneById = new Map(d.scenes.map((s) => [s.id, s]))
  const sceneByName = new Map(d.scenes.map((s) => [s.name, s]))
  const npcById = new Map(d.npcs.map((n) => [n.id, n]))
  const npcByName = new Map(d.npcs.map((n) => [n.name, n]))
  const clueById = new Map(d.clues.map((c) => [c.id, c]))
  const clueByName = new Map(d.clues.map((c) => [c.description, c]))
  const truthById = new Map((d.truths ?? []).map((t) => [String(t.id), t]))
  const truthByTitle = new Map((d.truths ?? []).map((t) => [t.title, t]))
  const pick = (ref: string, idMap: Map<string, { id?: string }>, nameMap: Map<string, { id?: string }>): string =>
    idMap.has(ref) ? ref : nameMap.get(ref)?.id ?? ref
  return {
    ...d,
    scenes: d.scenes.map((s) => ({
      ...s,
      npcIds: s.npcIds?.map((r) => pick(r, npcById, npcByName)),
      clueIds: s.clueIds?.map((r) => pick(r, clueById, clueByName)),
      requiredClues: s.requiredClues?.map((r) => pick(r, clueById, clueByName)),
    })),
    clues: d.clues.map((c) => ({
      ...c,
      requiredClues: c.requiredClues?.map((r) => pick(r, clueById, clueByName)),
    })),
    npcs: d.npcs.map((n) => ({
      ...n,
      relations: n.relations?.map((r) => ({ ...r, target: pick(r.target, npcById, npcByName) })),
    })),
    transitions: d.transitions?.map((t) => ({
      ...t,
      from: pick(t.from, sceneById, sceneByName),
      to: pick(t.to, sceneById, sceneByName),
      viaClues: t.viaClues?.map((r) => pick(r, clueById, clueByName)),
    })),
    truths: d.truths?.map((t) => ({
      ...t,
      relatedClues: t.relatedClues?.map((r) => pick(r, clueById, clueByName)),
      revealScene: t.revealScene ? pick(t.revealScene, sceneById, sceneByName) : undefined,
    })),
    endings: d.endings?.map((e) => ({
      ...e,
      relatedTruths: e.relatedTruths?.map((r) => pick(r, truthById, truthByTitle)),
    })),
  }
}

export interface DossierQuality {
  warnings: string[]
  /** 档案 sceneText 总字数 / 剧本总字数（%）；无剧本字数时不报告。 */
  coveragePct?: number
  sceneCount: number
  transitionCount: number
  eventCount: number
  relationCount: number
  truthCount: number
  endingCount: number
  /** 归一化后仍解析不到端点的切换边（from→to）。 */
  orphanTransitions: string[]
  orphanRelations: string[]
  orphanEventScenes: string[]
  orphanTruthRefs: string[]
  orphanEndingRefs: string[]
}

/**
 * Structural quality gate for a generated dossier. Never blocks (warnings are
 * surfaced to callers so a harness can decide), but flags the failure modes
 * that real runs exposed: batch-parses that produced near-empty dossiers,
 * orphan graph refs (edges/relations pointing at nothing), and sceneText
 * coverage so low the dossier cannot reconstruct the plot.
 */
export function assessDossier(d: StoryDossier, storyChars?: number): DossierQuality {
  const warnings: string[] = []
  const sceneIds = new Set(d.scenes.map((s) => s.id))
  const sceneNames = new Set(d.scenes.map((s) => s.name))
  const npcIds = new Set(d.npcs.map((n) => n.id))
  const npcNames = new Set(d.npcs.map((n) => n.name))
  const sceneKnown = (ref?: string) => !!ref && (sceneIds.has(ref) || sceneNames.has(ref))
  const npcKnown = (ref?: string) => !!ref && (npcIds.has(ref) || npcNames.has(ref))

  const orphanTransitions: string[] = []
  for (const t of d.transitions ?? []) {
    if (!sceneKnown(t.from) || !sceneKnown(t.to)) orphanTransitions.push(`${t.from}→${t.to}`)
  }
  if (orphanTransitions.length) warnings.push(`切换边 ${orphanTransitions.length} 条端点解析不到场景（可能跨模组引用或漏抽）：${orphanTransitions.slice(0, 5).join('、')}`)

  const orphanRelations: string[] = []
  let relationCount = 0
  for (const n of d.npcs) {
    for (const r of n.relations ?? []) {
      relationCount++
      if (!npcKnown(r.target)) orphanRelations.push(`${n.name}—${r.target}(${r.type})`)
    }
  }
  if (orphanRelations.length) warnings.push(`关系边 ${orphanRelations.length} 条指向未知 npc（检查名字一致性）：${orphanRelations.slice(0, 5).join('、')}`)

  const orphanEventScenes: string[] = []
  for (const e of d.events ?? []) {
    if (e.scene && !sceneKnown(e.scene)) orphanEventScenes.push(`${e.when ?? ''} ${e.summary.slice(0, 20)}@${e.scene}`)
  }
  if (orphanEventScenes.length) warnings.push(`事件 ${orphanEventScenes.length} 条引用的场景未知：${orphanEventScenes.slice(0, 3).join('、')}`)

  const clueKnown = (ref?: string) => !!ref && (new Set(d.clues.map((c) => c.id)).has(ref!) || new Set(d.clues.map((c) => c.description)).has(ref!))
  const truthKnown = (ref?: string) => !!ref && (new Set((d.truths ?? []).map((t) => t.id)).has(ref!) || new Set((d.truths ?? []).map((t) => t.title)).has(ref!))
  const orphanTruthRefs: string[] = []
  const orphanEndingRefs: string[] = []
  for (const t of d.truths ?? []) {
    for (const c of t.relatedClues ?? []) if (!clueKnown(c)) orphanTruthRefs.push(`${t.title}→线索「${c}」`)
    if (t.revealScene && !sceneKnown(t.revealScene)) orphanTruthRefs.push(`${t.title}→场景「${t.revealScene}」`)
  }
  if (orphanTruthRefs.length) warnings.push(`真相引用 ${orphanTruthRefs.length} 条指向未知实体：${orphanTruthRefs.slice(0, 3).join('、')}`)
  for (const e of d.endings ?? []) {
    for (const r of e.relatedTruths ?? []) if (!truthKnown(r)) orphanEndingRefs.push(`${e.name}→真相「${r}」`)
  }
  if (orphanEndingRefs.length) warnings.push(`结局引用 ${orphanEndingRefs.length} 条指向未知真相：${orphanEndingRefs.slice(0, 3).join('、')}`)
  if (typeof storyChars === 'number' && storyChars > 10_000 && !(d.truths?.length) && !(d.endings?.length)) {
    warnings.push('档案无真相/结局层（truths/endings 均为空）——结局/真相类问题将无法回答')
  }

  const totalSceneText = d.scenes.reduce((s, sc) => s + String(sc.sceneText ?? '').length, 0)
  let coveragePct: number | undefined
  if (typeof storyChars === 'number' && storyChars > 0) {
    coveragePct = Math.round((totalSceneText / storyChars) * 1000) / 10
    if (storyChars > 5_000 && coveragePct < 15) {
      warnings.push(`sceneText 覆盖率仅 ${coveragePct}%（${totalSceneText}/${storyChars} 字符），档案疑似严重欠抽——不足以反推剧情`)
    }
  }
  if (typeof storyChars === 'number' && storyChars > 12_000 && d.scenes.length <= 3) {
    warnings.push(`剧本 ${storyChars} 字符仅抽得 ${d.scenes.length} 个场景，疑似欠抽`)
  }
  for (const s of d.scenes) {
    if (typeof storyChars === 'number' && storyChars > 5_000 && !String(s.sceneText ?? '').trim()) {
      warnings.push(`场景「${s.name}」无 sceneText`)
      break
    }
  }

  return {
    warnings,
    coveragePct,
    sceneCount: d.scenes.length,
    transitionCount: d.transitions?.length ?? 0,
    eventCount: d.events?.length ?? 0,
    relationCount,
    truthCount: d.truths?.length ?? 0,
    endingCount: d.endings?.length ?? 0,
    orphanTransitions,
    orphanRelations,
    orphanEventScenes,
    orphanTruthRefs,
    orphanEndingRefs,
  }
}

/** Convert a dossier into the graph-facing ScriptContext shape. */
export function toScriptContext(d: StoryDossier): ScriptContext {
  return {
    meta: d.meta,
    scenes: d.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      npcIds: s.npcIds,
      clueIds: s.clueIds,
      transitionCondition: s.transitionCondition,
      requiredClues: s.requiredClues,
    })),
    clues: d.clues.map((c) => ({
      id: c.id,
      description: c.description,
      obtainCondition: c.obtainCondition,
      requiredClues: c.requiredClues,
    })),
    npcs: d.npcs.map((n) => ({
      id: n.id,
      name: n.name,
      description: n.description ?? n.role,
    })),
  }
}

export { parseScriptContent }
