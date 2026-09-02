/**
 * LLM 协议适配层（ADR-0003）— 统一内部格式与归一化结果。
 *
 * 内部统一格式 = OpenAI 风格 ChatMessage[] + KpToolDef tools；协议私有转换
 * （system 抽取、assistant tool_calls ↔ tool_use、工具结果回填）是各适配器
 * 的私有实现，不做跨协议统一转换层（Q10-A）。
 *
 * 适配器只做「单次请求 → 单次响应」的原子往返；工具调用循环留在
 * kpAgentService（Q9-A）。
 */
import type { KpToolDef } from '../../../../shared/tools/cocTools.js'
import type { AIProviderConfig, LLMProtocol } from '../../../../shared/constants/providers.js'

export type { LLMProtocol }

/** OpenAI 风格内部消息（与 aiService.ChatMessage 同构，迁移后统一于此） */
export interface ChatMessage {
  role: string
  content: string
  tool_calls?: {
    id?: string
    function?: { name?: string; arguments?: unknown }
    _thoughtSignature?: unknown
  }[]
  tool_call_id?: string
}

/** OpenAI-format tool definition — 单一来源 shared/tools/cocTools.ts */
export type ChatTool = KpToolDef

/** 归一化工具调用（适配器输出） */
export interface ToolCallResult {
  id: string
  name: string
  arguments: string
  _thoughtSignature?: string
}

/** 适配器统一调用参数 */
export interface LLMCallParams {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  tools?: ChatTool[]
  onChunk?: (chunk: string) => void
}

/** 适配器统一返回（内容 + 缓冲流块 + 工具调用） */
export interface LLMResult {
  stream: boolean
  content?: string
  chunks?: string[]
  toolCalls?: ToolCallResult[]
}

/** 模型列表条目（与 ModelOption 同构） */
export interface LLMModelOption {
  value: string
  label: string
}

/**
 * 协议适配器统一签名。
 * `config.baseUrl` 为已解析（默认值填充）的端点；`assertSafeOutboundUrl`
 * 由调用方（aiService resolveAiConfig / listModels）在进入适配器前执行。
 */
export type ProtocolAdapter = (config: AIProviderConfig, params: LLMCallParams) => Promise<LLMResult>
