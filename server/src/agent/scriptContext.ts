/**
 * Script context loading + clue-gating helpers for the KP graph.
 *
 * The script schema (`original/ai-trpg-web/schemas/coc-script.schema.json`)
 * defines `clues[].obtainCondition` / `scenes[].transitionCondition` as
 * free-text strings — there is no machine-readable gate. This module adds an
 * OPTIONAL structured layer on top and a deliberately small free-text grammar:
 *   - `clues[].requiredClues?: string[]`  — clue ids that must be obtained
 *     before this clue can be granted (structured obtainCondition).
 *   - `scenes[].requiredClues?: string[]` — clue ids that unlock the scene
 *     (structured transitionCondition).
 *   - `obtainCondition` / `transitionCondition`: `requires_clues: id1, id2`.
 *
 * Two-track gating:
 *   - Structured conditions present → programmatic unlock checks, unchanged.
 *   - Supported free-text conditions → deterministic clue-id checks.
 *   - Other non-empty free text → fail closed as ambiguous; it cannot unlock
 *     anything until rewritten in the supported format or structured form.
 *
 * Script JSON is loaded via storyService.readStory (stories are stored per
 * user under UPLOADS_DIR/<userId>/stories/<id>) with a short TTL cache.
 */
import { readStory } from '../services/storyService.js'

export interface ScriptClue {
  id: string
  description: string
  obtainCondition?: string
  requiredClues?: string[]
}

export interface ScriptScene {
  id: string
  name: string
  description?: string
  npcIds?: string[]
  clueIds?: string[]
  transitionCondition?: string
  requiredClues?: string[]
}

export interface ScriptContext {
  meta?: { title?: string; ruleSystem?: string }
  scenes: ScriptScene[]
  clues: ScriptClue[]
  npcs: { id: string; name: string; description?: string }[]
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { loadedAt: number; ctx: ScriptContext }>()

function cacheKey(userId: number, scriptId: string): string {
  return `${userId}:${scriptId}`
}

/** Parse a story file's raw content into a structured ScriptContext (null when not a COC script JSON). */
export function parseScriptContent(content: string): ScriptContext | null {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const obj = data as { meta?: unknown; scenes?: unknown; clues?: unknown; npcs?: unknown }
  if (!Array.isArray(obj.scenes)) return null
  const scenes: ScriptScene[] = []
  for (const s of obj.scenes) {
    if (typeof s !== 'object' || s === null) continue
    const sc = s as ScriptScene
    if (typeof sc.id !== 'string') continue
    scenes.push({
      id: sc.id,
      name: typeof sc.name === 'string' ? sc.name : sc.id,
      description: typeof sc.description === 'string' ? sc.description : undefined,
      npcIds: Array.isArray(sc.npcIds) ? sc.npcIds.filter((x): x is string => typeof x === 'string') : undefined,
      clueIds: Array.isArray(sc.clueIds) ? sc.clueIds.filter((x): x is string => typeof x === 'string') : undefined,
      transitionCondition: typeof sc.transitionCondition === 'string' ? sc.transitionCondition : undefined,
      requiredClues: Array.isArray(sc.requiredClues) ? sc.requiredClues.filter((x): x is string => typeof x === 'string') : undefined,
    })
  }
  const clues: ScriptClue[] = []
  if (Array.isArray(obj.clues)) {
    for (const c of obj.clues) {
      if (typeof c !== 'object' || c === null) continue
      const cl = c as ScriptClue
      if (typeof cl.id !== 'string') continue
      clues.push({
        id: cl.id,
        description: typeof cl.description === 'string' ? cl.description : cl.id,
        obtainCondition: typeof cl.obtainCondition === 'string' ? cl.obtainCondition : undefined,
        requiredClues: Array.isArray(cl.requiredClues) ? cl.requiredClues.filter((x): x is string => typeof x === 'string') : undefined,
      })
    }
  }
  const npcs: ScriptContext['npcs'] = []
  if (Array.isArray(obj.npcs)) {
    for (const n of obj.npcs) {
      if (typeof n !== 'object' || n === null) continue
      const npc = n as { id?: unknown; name?: unknown; description?: unknown }
      if (typeof npc.id !== 'string') continue
      npcs.push({
        id: npc.id,
        name: typeof npc.name === 'string' ? npc.name : npc.id,
        description: typeof npc.description === 'string' ? npc.description : undefined,
      })
    }
  }
  return { meta: obj.meta as ScriptContext['meta'], scenes, clues, npcs }
}

/**
 * Load the structured script for a user+scriptId; null when the story has no
 * structured context, and throw when its source cannot be read.
 *
 * Two sources (experiment branch feature/kp-dossier-workflow):
 *  1. A generated dossier (`rag/dossier/dossierCore`), which is the
 *     structured digest of ANY story format (PDF/txt/md…) produced by an LLM.
 *     This makes clue/scene gating work for dossier rooms on arbitrary files.
 *  2. Fallback: a hand-authored COC script JSON (legacy path) — behavior
 *     unchanged when no dossier exists.
 * Dynamic import keeps the dossier module off the hot graph path when unused.
 */
export async function loadScriptContext(userId: number, scriptId: string): Promise<ScriptContext | null> {
  if (!scriptId || !userId) return null
  const key = cacheKey(userId, scriptId)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.ctx

  // Source 1: generated dossier (dossier workflow).
  try {
    const { loadDossier } = await import('../rag/dossier/dossierCore.js')
    const dossier = await loadDossier(userId, scriptId)
    if (dossier) {
      const { toScriptContext } = await import('../rag/dossier/schema.js')
      const ctx = toScriptContext(dossier)
      if (ctx) cache.set(key, { loadedAt: Date.now(), ctx })
      return ctx
    }
  } catch {
    // dossier unavailable → fall through to legacy script JSON
  }

  // Source 2: hand-authored COC script JSON (legacy).
  let raw: { content: string } | null = null
  try {
    raw = await readStory(userId, scriptId)
  } catch (error) {
    // A read failure is different from an ordinary text story: the caller may
    // be enforcing clue or scene conditions from this source.
    throw error
  }
  const ctx = parseScriptContent(raw?.content ?? '')
  if (ctx) cache.set(key, { loadedAt: Date.now(), ctx })
  return ctx
}

/** Find a scene by id, name, or a player text that CONTAINS a scene name
 * (case-insensitive; the longest matching name wins to avoid short-name
 * false positives like "地下" matching "地下密室" and "地下室"). */
export function findScene(ctx: ScriptContext, nameOrId: string): ScriptScene | null {
  const target = String(nameOrId || '').trim()
  if (!target) return null
  for (const s of ctx.scenes) {
    if (s.id === target || s.name === target) return s
  }
  const lower = target.toLowerCase()
  for (const s of ctx.scenes) {
    if (s.name.toLowerCase() === lower) return s
  }
  let best: ScriptScene | null = null
  let bestLen = 0
  for (const s of ctx.scenes) {
    const name = s.name.toLowerCase()
    if (name && lower.includes(name) && name.length > bestLen) {
      best = s
      bestLen = name.length
    }
  }
  return best
}

type ConditionGateReason = 'missing-clues' | 'ambiguous-condition' | 'unknown-clue'

interface ConditionGate {
  unlocked: boolean | null
  missing: string[]
  reason?: ConditionGateReason
}

/** Normalize only the explicit grammar; natural-language matching is unsafe. */
function parseFreeTextCondition(condition: string): { requiredClues: string[] } | { error: 'ambiguous-condition' } {
  const match = /^requires_clues:\s*([^\s,]+(?:\s*,\s*[^\s,]+)*)$/i.exec(condition.trim())
  if (!match) return { error: 'ambiguous-condition' }
  const requiredClues = [...new Set(match[1]!.split(',').map((id) => id.trim()).filter(Boolean))]
  return requiredClues.length > 0 ? { requiredClues } : { error: 'ambiguous-condition' }
}

function evaluateCondition(
  structuredRequired: string[] | undefined,
  freeTextCondition: string | undefined,
  obtained: Set<string>,
  knownClueIds?: Set<string>,
): ConditionGate {
  // A non-empty structured condition remains authoritative over legacy text.
  if (Array.isArray(structuredRequired) && structuredRequired.length > 0) {
    const missing = structuredRequired.filter((id) => !obtained.has(id))
    return { unlocked: missing.length === 0, missing, ...(missing.length ? { reason: 'missing-clues' as const } : {}) }
  }

  const text = freeTextCondition?.trim()
  if (!text) return { unlocked: null, missing: [] }
  const parsed = parseFreeTextCondition(text)
  if ('error' in parsed) return { unlocked: false, missing: [], reason: parsed.error }

  const unknown = knownClueIds
    ? parsed.requiredClues.filter((id) => !knownClueIds.has(id))
    : []
  if (unknown.length > 0) return { unlocked: false, missing: unknown, reason: 'unknown-clue' }

  const missing = parsed.requiredClues.filter((id) => !obtained.has(id))
  return { unlocked: missing.length === 0, missing, ...(missing.length ? { reason: 'missing-clues' as const } : {}) }
}

/**
 * Scene unlock check.
 *  - `true`  — any structured or supported free-text prerequisites are met.
 *  - `false` — prerequisites are missing or the non-empty condition is invalid.
 *  - `null`  — no structured or free-text condition is present.
 */
export function sceneUnlocked(
  scene: ScriptScene,
  obtainedClueIds: string[],
  ctx?: Pick<ScriptContext, 'clues'>,
): ConditionGate {
  const obtained = new Set(obtainedClueIds || [])
  const knownClueIds = ctx ? new Set(ctx.clues.map((clue) => clue.id)) : undefined
  return evaluateCondition(scene.requiredClues, scene.transitionCondition, obtained, knownClueIds)
}

/** Evaluate a clue's prerequisites, including legacy free-text conditions. */
export function clueUnlocked(
  clue: ScriptClue,
  obtainedClueIds: string[],
  ctx: Pick<ScriptContext, 'clues'>,
): ConditionGate {
  const obtained = new Set(obtainedClueIds || [])
  const knownClueIds = new Set(ctx.clues.map((candidate) => candidate.id))
  return evaluateCondition(clue.requiredClues, clue.obtainCondition, obtained, knownClueIds)
}

/** Clues available in a scene that the player has not obtained and whose prerequisites are met. */
export function getAvailableClues(
  scene: ScriptScene,
  obtainedClueIds: string[],
  ctx: ScriptContext,
): { clue: ScriptClue; reason: 'open' | 'unlocked-by-clue'; missing: string[] }[] {
  const obtained = new Set(obtainedClueIds || [])
  const clueIds = scene.clueIds || []
  const result: { clue: ScriptClue; reason: 'open' | 'unlocked-by-clue'; missing: string[] }[] = []
  for (const id of clueIds) {
    if (obtained.has(id)) continue
    const clue = ctx.clues.find((c) => c.id === id)
    if (!clue) continue
    const gate = clueUnlocked(clue, obtainedClueIds, ctx)
    if (gate.unlocked === false) continue
    result.push({ clue, reason: gate.unlocked ? 'unlocked-by-clue' : 'open', missing: [] })
  }
  return result
}

/** Clues withheld by prerequisites or fail-safe free-text validation. */
export function getBlockedClues(
  scene: ScriptScene,
  obtainedClueIds: string[],
  ctx: ScriptContext,
): { clue: ScriptClue; missing: string[]; reason: ConditionGateReason }[] {
  const obtained = new Set(obtainedClueIds || [])
  const blocked: { clue: ScriptClue; missing: string[]; reason: ConditionGateReason }[] = []
  for (const id of scene.clueIds || []) {
    if (obtained.has(id)) continue
    const clue = ctx.clues.find((candidate) => candidate.id === id)
    if (!clue) continue
    const gate = clueUnlocked(clue, obtainedClueIds, ctx)
    if (gate.unlocked === false) {
      blocked.push({ clue, missing: gate.missing, reason: gate.reason ?? 'missing-clues' })
    }
  }
  return blocked
}

/** NPC records for a scene (used to render the activeNPCs prompt block server-side). */
export function getSceneNpcs(ctx: ScriptContext, scene: ScriptScene): { name: string; role?: string }[] {
  const npcIds = scene.npcIds || []
  return npcIds
    .map((id) => ctx.npcs.find((n) => n.id === id))
    .filter((n): n is { id: string; name: string; description?: string } => !!n)
    .map((n) => ({ name: n.name, role: n.description }))
}
