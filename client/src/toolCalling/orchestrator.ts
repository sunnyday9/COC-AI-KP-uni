/**
 * Orchestrator: routes each tool call to the owning handler and aggregates results.
 * 工具名单以 shared/tools/cocTools.ts 的 COC_TOOL_NAMES 为单一来源（与 server 端
 * COC_KP_TOOLS 同源，取代原 cocToolNames.json，Task 10）。
 */
import type { ToolCall, ToolHandler, ToolHandlerContext, ToolHandlerResult } from './types'
import type { Message } from '../types/game'
import { traceBus } from '../services/tracing'
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools'
import { checkHandler } from './handlers/checkHandler'
import { combatHandler } from './handlers/combatHandler'
import { sanityHandler } from './handlers/sanityHandler'
import { resourceHandler } from './handlers/resourceHandler'
import { narrativeHandler } from './handlers/narrativeHandler'

const HANDLERS: ToolHandler[] = [
  checkHandler,
  combatHandler,
  sanityHandler,
  resourceHandler,
  narrativeHandler,
]

const NAME_TO_HANDLER: Map<string, ToolHandler> = (() => {
  const m = new Map<string, ToolHandler>()
  for (const h of HANDLERS) {
    for (const name of h.toolNames) {
      m.set(name, h)
    }
  }
  return m
})()

/** 校验：COC_TOOL_NAMES（shared 单一来源）中的每个工具均有对应 handler，避免前后端工具不一致 */
if (import.meta.env?.DEV) {
  const missing = COC_TOOL_NAMES.filter((name) => !NAME_TO_HANDLER.has(name))
  if (missing.length) {
    console.warn('[toolCalling] 以下工具在 COC_TOOL_NAMES 中定义但缺少前端 handler:', missing)
  }
}

export interface ProcessToolCallsResult {
  toolResults: { role: 'tool'; tool_call_id: string; content: string }[]
  displayMessages: Message[]
}

/**
 * Process a batch of tool calls: route each to its handler, collect results and display messages.
 */
export function processToolCalls(
  toolCalls: ToolCall[],
  context: ToolHandlerContext
): ProcessToolCallsResult {
  const toolResults: ProcessToolCallsResult['toolResults'] = []
  const displayMessages: Message[] = []

  for (const tc of toolCalls) {
    let content: string
    let messages: Message[] = []
    const toolStart = Date.now()
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
      const handler = NAME_TO_HANDLER.get(tc.name)
      if (handler) {
        const result: ToolHandlerResult = handler.handle(tc.name, parsedArgs, context)
        content = result.content
        messages = result.displayMessages
      } else {
        content = `error: unknown tool "${tc.name}"`
        messages = []
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      content = `error: ${reason}`
    }
    traceBus.emit('tool_execution', 'tool_executed', {
      name: tc.name,
      args: parsedArgs,
      resultSummary: content.slice(0, 300),
      success: !content.startsWith('error'),
      durationMs: Date.now() - toolStart,
    })
    toolResults.push({ role: 'tool', tool_call_id: tc.id, content })
    displayMessages.push(...messages)
  }

  return { toolResults, displayMessages }
}

/** Category names and their tool lists (for docs). */
export const COC_TOOL_CATEGORIES: Record<string, string[]> = {
  Check: [...checkHandler.toolNames],
  Combat: [...combatHandler.toolNames],
  Sanity: [...sanityHandler.toolNames],
  Resource: [...resourceHandler.toolNames],
  Narrative: [...narrativeHandler.toolNames],
}
