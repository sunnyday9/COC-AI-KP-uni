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
  meta?: { title?: string; ruleSystem?: string }
  /** Free-text search index: term → weight (lightweight lexical fallback). */
  search?: Record<string, number>
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

export interface DossierNpc {
  id: string
  name: string
  description?: string
  role?: string
  /** Story excerpts that describe this NPC. */
  details?: string
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
  if (scenes.length === 0 && clues.length === 0 && npcs.length === 0) return null
  const scriptId = typeof obj.scriptId === 'string' ? obj.scriptId : ''
  const storyName = typeof obj.storyName === 'string' ? obj.storyName : scriptId
  const meta = (obj.meta && typeof obj.meta === 'object') ? (obj.meta as StoryDossier['meta']) : undefined
  return {
    scriptId,
    storyName,
    generatedAt: typeof obj.generatedAt === 'number' ? obj.generatedAt : Date.now(),
    generatedByModel: typeof obj.generatedByModel === 'string' ? obj.generatedByModel : undefined,
    scenes,
    clues,
    npcs,
    meta,
    search: (obj.search && typeof obj.search === 'object') ? (obj.search as Record<string, number>) : undefined,
  }
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
  return {
    id: typeof np.id === 'string' && np.id ? np.id : name,
    name,
    description: typeof np.description === 'string' ? np.description : undefined,
    role: typeof np.role === 'string' ? np.role : undefined,
    details: typeof np.details === 'string' ? np.details : undefined,
  }
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && !!x)
  return out.length ? out : undefined
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
