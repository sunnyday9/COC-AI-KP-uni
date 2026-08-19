/**
 * Script context loading + clue-gating helpers for the KP graph.
 *
 * The script schema (`original/ai-trpg-web/schemas/coc-script.schema.json`)
 * defines `clues[].obtainCondition` / `scenes[].transitionCondition` as
 * free-text strings — there is no machine-readable gate. This module adds an
 * OPTIONAL structured layer on top:
 *   - `clues[].requiredClues?: string[]`  — clue ids that must be obtained
 *     before this clue can be granted (structured obtainCondition).
 *   - `scenes[].requiredClues?: string[]` — clue ids that unlock the scene
 *     (structured transitionCondition).
 *
 * Two-track gating:
 *   - Structured conditions present → programmatic unlock checks.
 *   - Free-text only (original scripts) → `null` result; the raw condition
 *     text is injected into the plan prompt as reference, never enforced, so
 *     legacy scripts behave exactly as before.
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

/** Load the structured script for a user+scriptId; null when unavailable / not a script JSON. */
export async function loadScriptContext(userId: number, scriptId: string): Promise<ScriptContext | null> {
  if (!scriptId || !userId) return null
  const key = cacheKey(userId, scriptId)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.ctx
  let raw: { content: string } | null = null
  try {
    raw = await readStory(userId, scriptId)
  } catch {
    return null
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

function hasAllClues(required: string[], obtained: Set<string>): boolean {
  for (const r of required) {
    if (!obtained.has(r)) return false
  }
  return true
}

/**
 * Scene unlock check.
 *  - `true`  — scene has structured requiredClues and they are all obtained.
 *  - `false` — scene has structured requiredClues and some are missing
 *    (missing ids are also returned for prompt hints).
 *  - `null`  — no structured condition (free-text script) → not enforced.
 */
export function sceneUnlocked(
  scene: ScriptScene,
  obtainedClueIds: string[],
): { unlocked: boolean | null; missing: string[] } {
  const required = scene.requiredClues
  if (!Array.isArray(required) || required.length === 0) return { unlocked: null, missing: [] }
  const obtained = new Set(obtainedClueIds || [])
  const missing = required.filter((r) => !obtained.has(r))
  return { unlocked: missing.length === 0, missing }
}

/** Clues available in a scene that the player has not obtained yet and whose structured prerequisites are met. */
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
    const required = clue.requiredClues
    if (Array.isArray(required) && required.length > 0) {
      const missing = required.filter((r) => !obtained.has(r))
      if (missing.length > 0) continue // gated behind other clues
      result.push({ clue, reason: 'unlocked-by-clue', missing: [] })
    } else {
      result.push({ clue, reason: 'open', missing: [] })
    }
  }
  return result
}

/** NPC records for a scene (used to render the activeNPCs prompt block server-side). */
export function getSceneNpcs(ctx: ScriptContext, scene: ScriptScene): { name: string; role?: string }[] {
  const npcIds = scene.npcIds || []
  return npcIds
    .map((id) => ctx.npcs.find((n) => n.id === id))
    .filter((n): n is { id: string; name: string; description?: string } => !!n)
    .map((n) => ({ name: n.name, role: n.description }))
}
