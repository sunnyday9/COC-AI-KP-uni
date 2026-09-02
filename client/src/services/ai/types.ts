/**
 * AI protocol types & constants — re-exported from shared (ADR-0003:
 * protocol first-class; migrated from provider-based exports).
 * Chat* 类型是客户端 IPC 契约形态（不再与 shared provider 常量耦合）。
 */
export {
  PROTOCOL_DEFS,
  getProtocolDef,
  resolveProtocolDefaultBaseUrl,
} from '../../../../shared/constants/providers'
export type {
  AIProviderConfig,
  LLMProtocol,
  ProtocolDef,
  ModelOption,
} from '../../../../shared/constants/providers'

/** 客户端 chat 契约类型（api-contract §3 形态） */
export interface ChatMessage {
  role: string
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatResponse {
  content: string
  finishReason?: string
}

export type ChatStream = AsyncIterable<string>

export interface AIAdapter {
  chat(request: ChatRequest): Promise<ChatResponse | ChatStream>
}
