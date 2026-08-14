import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from '../types'

const TOOL_NAMES = ['adjust_mp', 'spend_luck'] as const

export const resourceHandler: ToolHandler = {
  toolNames: [...TOOL_NAMES],
  handle(toolName: string, args: Record<string, unknown>, context: ToolHandlerContext): ToolHandlerResult {
    const displayMessages: ToolHandlerResult['displayMessages'] = []
    const id = context.generateId()
    const ts = Date.now()

    if (toolName === 'adjust_mp') {
      const delta = Number(args.delta ?? 0)
      context.updateCharacterMP(delta)
      displayMessages.push({
        id,
        timestamp: ts,
        role: 'system',
        content: delta >= 0 ? `MP +${delta}` : `MP ${delta}`,
      })
      return { content: `MP adjusted by ${delta}`, displayMessages }
    }

    if (toolName === 'spend_luck') {
      const amount = Math.max(1, Math.min(99, Math.floor(Number(args.amount ?? 0))))
      const c = context.characterSheet
      const currentLuck = c?.attributes?.luck ?? 0
      const actual = Math.min(amount, currentLuck)
      const newLuck = currentLuck - actual
      if (actual > 0) context.updateCharacterLuck(-actual)
      displayMessages.push({
        id,
        timestamp: ts,
        role: 'system',
        content: `消耗幸运 ${actual}，当前幸运: ${newLuck}`,
      })
      return {
        content: JSON.stringify({ spent: actual, previousLuck: currentLuck, newLuck }),
        displayMessages,
      }
    }

    return { content: 'error: unknown tool', displayMessages: [] }
  },
}
