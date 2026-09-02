/**
 * LLM 协议分发（ADR-0003）— 按 protocol 路由到对应适配器。
 *
 * 消费面（aiService.chat/chatForAgent/chatForRag）只依赖本模块的
 * `dispatch`；适配器实现（openaiChat / anthropicMessages / google /
 * openaiResponses）不暴露给外部。出站 URL 安全门（assertSafeOutboundUrl）
 * 由调用方在进入 dispatch 前执行。
 */
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'
import { BadRequestError } from '../../utils/errors.js'
import { openaiChatAdapter } from './openaiChat.js'
import { anthropicMessagesAdapter } from './anthropicMessages.js'
import { googleAdapter } from './google.js'
import { openaiResponsesAdapter } from './openaiResponses.js'
import type { LLMCallParams, LLMResult } from './types.js'

export type { LLMCallParams, LLMResult, ChatMessage, ChatTool, ToolCallResult } from './types.js'

/**
 * 按 config.protocol 分发到对应适配器。
 * config.baseUrl 已由调用方解析（默认值填充）并过 assertSafeOutboundUrl。
 */
export async function dispatch(config: AIProviderConfig, params: LLMCallParams): Promise<LLMResult> {
  switch (config.protocol) {
    case 'openai_chat':
      return openaiChatAdapter(config, params)
    case 'openai_responses':
      return openaiResponsesAdapter(config, params)
    case 'anthropic_messages':
      return anthropicMessagesAdapter(config, params)
    case 'google_compatible':
      return googleAdapter(config, params)
    default:
      throw new BadRequestError(`Unknown protocol: ${config.protocol}`)
  }
}
