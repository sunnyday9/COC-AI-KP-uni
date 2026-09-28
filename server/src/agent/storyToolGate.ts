import { clueUnlocked, findScene, sceneUnlocked, type ScriptContext } from './scriptContext.js'
import type { NarrativeToolResolution } from '../rule-engine/types.js'

function blockedReason(
  gate: ReturnType<typeof sceneUnlocked>,
  subject: string,
  condition: string | undefined,
  ctx: ScriptContext,
): string {
  if (gate.reason === 'ambiguous-condition') {
    return `Story condition blocks ${subject}: "${condition ?? ''}" is ambiguous and cannot be safely evaluated. Keep it locked and explain this limitation to the player.`
  }
  if (gate.reason === 'unknown-clue') {
    return `Story condition blocks ${subject}: the script references unknown clue ID(s) ${gate.missing.join(', ')}. Keep it locked and explain that the story configuration needs correction.`
  }
  const missing = gate.missing
    .map((id) => ctx.clues.find((clue) => clue.id === id)?.description ?? id)
    .join(', ')
  return `Story condition blocks ${subject}: missing prerequisite clue(s): ${missing}. Keep it locked and explain what is still needed to the player.`
}

function normalizedDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''
}

/**
 * Server-side enforcement for narrative mutations. Returns normalized args for
 * recognized script entries, a denial for locked entries, or null when the
 * call does not target a known entry in this script (legacy free-form behavior).
 */
export function resolveStoryToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ScriptContext,
  obtainedClueIds: string[],
  currentSceneName?: string,
): NarrativeToolResolution {
  if (toolName === 'transition_scene') {
    const requestedName = typeof args.sceneName === 'string' ? args.sceneName : ''
    const scene = findScene(ctx, requestedName)
    if (!scene) return null

    const currentScene = currentSceneName ? findScene(ctx, currentSceneName) : null
    if (currentScene?.name === scene.name) return { args: { ...args, sceneName: scene.name } }

    const gate = sceneUnlocked(scene, obtainedClueIds, ctx)
    if (gate.unlocked === false) {
      return { error: blockedReason(gate, `scene "${scene.name}"`, scene.transitionCondition, ctx) }
    }
    return { args: { ...args, sceneName: scene.name } }
  }

  if (toolName === 'grant_clue') {
    const requestedId = typeof args.clueId === 'string' ? args.clueId.trim() : ''
    const clueById = requestedId ? ctx.clues.find((clue) => clue.id === requestedId) : undefined
    const descriptionKey = normalizedDescription(args.description)
    const cluesByDescription = descriptionKey
      ? ctx.clues.filter((clue) => normalizedDescription(clue.description) === descriptionKey)
      : []

    // A known ID is authoritative. Without one, only an exact, unique
    // description is safe to map; fuzzy description matching could award the
    // wrong clue or bypass a gate.
    const clue = clueById ?? (cluesByDescription.length === 1 ? cluesByDescription[0] : undefined)
    if (!clue) {
      if (cluesByDescription.length > 1) {
        return { error: 'Story condition blocks this clue grant: its description matches multiple scripted clues, so it cannot be safely identified. Keep it locked and explain the ambiguity to the player.' }
      }
      return null
    }

    const currentScene = currentSceneName ? findScene(ctx, currentSceneName) : null
    if (currentScene?.clueIds && !currentScene.clueIds.includes(clue.id)) {
      return { error: `Story condition blocks clue "${clue.description}": it is not listed in the current scene "${currentScene.name}". Keep it locked and explain the scene mismatch to the player.` }
    }

    const gate = clueUnlocked(clue, obtainedClueIds, ctx)
    if (gate.unlocked === false) {
      return { error: blockedReason(gate, `clue "${clue.description}"`, clue.obtainCondition, ctx) }
    }
    return { args: { ...args, description: clue.description, clueId: clue.id } }
  }

  return null
}
