/**
 * Orchestrator: routes each tool call to the owning handler and aggregates results.
 * 迁自 client/src/toolCalling/orchestrator.ts（Phase A1 规则引擎下沉）。
 * 工具名单以 shared/tools/cocTools.ts 的 COC_TOOL_NAMES 为单一来源。
 *
 * 与 client 版差异：traceBus 引用改为注入式 hooks（服务端无 traceBus；
 * 由调用方（RoomService / 会话执行器）决定工具执行事件发往何处）。
 */
import type { ToolCall, ToolHandler, ToolHandlerContext, ToolHandlerResult } from './types.js'
import type { Message } from '../../../shared/types/game.js'
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.js'
import { checkHandler } from './handlers/checkHandler.js'
import { combatHandler } from './handlers/combatHandler.js'
import { sanityHandler } from './handlers/sanityHandler.js'
import { resourceHandler } from './handlers/resourceHandler.js'
import { narrativeHandler } from './handlers/narrativeHandler.js'
import { rulesHandler } from './handlers/rulesHandler.js'

const HANDLERS: ToolHandler[] = [
  checkHandler,
  combatHandler,
  sanityHandler,
  resourceHandler,
  narrativeHandler,
  rulesHandler,
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

/** 校验：COC_TOOL_NAMES（shared 单一来源）中的每个工具均有对应 handler，避免工具不一致 */
{
  const missing = COC_TOOL_NAMES.filter((name) => !NAME_TO_HANDLER.has(name))
  if (missing.length) {
    console.warn('[rule-engine] 以下工具在 COC_TOOL_NAMES 中定义但缺少 handler:', missing)
  }
}

export interface ProcessToolCallsResult {
  toolResults: { role: 'tool'; tool_call_id: string; content: string }[]
  displayMessages: Message[]
}

/** 工具执行事件钩子（注入化，替代原客户端 traceBus 直接引用）。 */
export interface ToolExecutionHooks {
  onToolExecuted?: (info: {
    name: string
    args: Record<string, unknown>
    resultSummary: string
    success: boolean
    durationMs: number
  }) => void
}

/**
 * Process a batch of tool calls: route each to its handler, collect results and display messages.
 */
export function processToolCalls(
  toolCalls: ToolCall[],
  context: ToolHandlerContext,
  hooks?: ToolExecutionHooks
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
    hooks?.onToolExecuted?.({
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
