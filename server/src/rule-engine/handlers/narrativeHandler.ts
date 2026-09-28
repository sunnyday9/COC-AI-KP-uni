import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from '../types.js'

const TOOL_NAMES = ['transition_scene', 'grant_clue', 'end_game'] as const

export const narrativeHandler: ToolHandler = {
  toolNames: [...TOOL_NAMES],
  handle(toolName: string, args: Record<string, unknown>, context: ToolHandlerContext): ToolHandlerResult {
    const displayMessages: ToolHandlerResult['displayMessages'] = []
    const id = context.generateId()
    const ts = Date.now()

    if (toolName === 'transition_scene') {
      const initialSceneName = String(args.sceneName ?? '')
      if (!initialSceneName) return { content: 'error: sceneName required', displayMessages: [] }
      const resolution = context.resolveNarrativeToolCall?.(toolName, args)
      if (resolution && 'error' in resolution) return { content: `error: ${resolution.error}`, displayMessages: [] }
      const resolvedArgs = resolution && 'args' in resolution ? resolution.args : args
      const sceneName = String(resolvedArgs.sceneName ?? initialSceneName)
      if (sceneName) {
        context.transitionToScene(sceneName)
        displayMessages.push({ id, timestamp: ts, role: 'system', content: `场景切换: ${sceneName}` })
        return { content: `Scene transitioned to: ${sceneName}`, displayMessages }
      }
      return { content: 'error: sceneName required', displayMessages: [] }
    }

    if (toolName === 'grant_clue') {
      const initialDescription = String(args.description ?? '')
      if (!initialDescription) return { content: 'error: description required', displayMessages: [] }
      const resolution = context.resolveNarrativeToolCall?.(toolName, args)
      if (resolution && 'error' in resolution) return { content: `error: ${resolution.error}`, displayMessages: [] }
      const resolvedArgs = resolution && 'args' in resolution ? resolution.args : args
      const description = String(resolvedArgs.description ?? initialDescription)
      const clueId = String(resolvedArgs.clueId ?? args.clueId ?? '')
      if (description) {
        context.addClue(description, clueId || undefined)
        displayMessages.push({ id, timestamp: ts, role: 'system', content: `获得线索: ${description}` })
        return { content: `Clue granted: ${description}`, displayMessages }
      }
      return { content: 'error: description required', displayMessages: [] }
    }

    if (toolName === 'end_game') {
      const outcome = String(args.outcome ?? 'unknown')
      const title = String(args.title ?? '').trim() || '结局'
      const summary = String(args.summary ?? '').trim()
      const epilogueOptions = Array.isArray(args.epilogueOptions) ? args.epilogueOptions.map((s) => String(s)).filter(Boolean).slice(0, 8) : []
      const keyFacts = Array.isArray(args.keyFacts) ? args.keyFacts.map((s) => String(s)).filter(Boolean).slice(0, 12) : []
      const keyTurnIds = Array.isArray(args.keyTurnIds) ? args.keyTurnIds.map((s) => String(s)).filter(Boolean).slice(0, 12) : []
      if (!summary) return { content: 'error: summary required', displayMessages: [] }
      context.endGame({ outcome, title, summary, epilogueOptions, keyFacts, keyTurnIds })
      displayMessages.push({ id, timestamp: ts, role: 'system', content: `游戏结束: ${title}` })
      return { content: `Game ended: ${title}`, displayMessages }
    }

    return { content: 'error: unknown tool', displayMessages: [] }
  },
}
