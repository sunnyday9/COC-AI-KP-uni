/**
 * RuleEngine（服务端规则引擎）入口 — Phase A1。
 * 迁自 client/src/toolCalling/*（工具执行链），供服务端图内工具循环使用。
 * 纯规则（shared/coc）与执行链（本目录）分离：本目录只负责把
 * LLM 的 tool_calls 路由到 handler 并产出 tool 结果与展示消息。
 */
export { processToolCalls, COC_TOOL_CATEGORIES, type ProcessToolCallsResult, type ToolExecutionHooks } from './orchestrator.js'
export type { ToolCall, ToolHandler, ToolHandlerContext, ToolHandlerResult } from './types.js'
