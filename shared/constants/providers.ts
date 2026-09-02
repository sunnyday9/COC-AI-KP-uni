/**
 * LLM 协议常量（ADR-0003 一等公民）— `settings.ai.protocol` 是唯一协议真源，
 * 不随 provider 推导。协议模型取代旧 provider→protocol 两级结构
 * （PresetProvider/CustomProvider 已删除，见 ADR-0003 / T1/T5）。
 *
 * 共享方：server（settingsService 校验、aiService/listModels 默认 endpoint）
 * 与 client（设置页协议卡片）。
 */

/** 可用的 LLM 接入协议（ADR-0003 一等公民） */
export type LLMProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'google_compatible'

export const LLM_PROTOCOLS: readonly LLMProtocol[] = [
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
  'google_compatible',
] as const

export const ALL_PROTOCOL_IDS = new Set<string>(LLM_PROTOCOLS)

/** 各协议默认 baseUrl（用户留空时使用） */
export const PROTOCOL_DEFAULT_BASE_URL: Record<LLMProtocol, string> = {
  openai_chat: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
  anthropic_messages: 'https://api.anthropic.com',
  google_compatible: 'https://generativelanguage.googleapis.com',
}

export function resolveProtocolDefaultBaseUrl(protocol: LLMProtocol): string {
  return PROTOCOL_DEFAULT_BASE_URL[protocol]
}

/** 协议展示元数据（设置页协议卡片 / placeholder） */
export interface ProtocolDef {
  id: LLMProtocol
  label: string
  description: string
  defaultBaseUrl: string
  apiKeyPlaceholder: string
}

export const PROTOCOL_DEFS: readonly ProtocolDef[] = [
  {
    id: 'openai_chat',
    label: 'OpenAI Chat',
    description: 'Chat Completions（GPT-4o 等）',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-...',
  },
  {
    id: 'openai_responses',
    label: 'OpenAI Responses',
    description: 'Responses API（GPT-5 等）',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-...',
  },
  {
    id: 'anthropic_messages',
    label: 'Anthropic Messages',
    description: 'Claude Messages API',
    defaultBaseUrl: 'https://api.anthropic.com',
    apiKeyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'google_compatible',
    label: 'Gemini',
    description: 'Google Gemini（遗留）',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    apiKeyPlaceholder: 'AIza...',
  },
]

export function getProtocolDef(id: LLMProtocol): ProtocolDef | undefined {
  return PROTOCOL_DEFS.find((p) => p.id === id)
}

/** AI 配置（settings.ai）— 协议一等公民 */
export interface AIProviderConfig {
  protocol: LLMProtocol
  baseUrl?: string
  model?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}

export interface ModelOption {
  value: string
  label: string
}

/**
 * 静态预设模型列表。现仅 anthropic_messages 用作实时拉取失败的回退
 * （T4 #11）；openai_chat / openai_responses 全部走实时 GET {baseUrl}/models。
 */
export const AI_MODEL_LISTS: Record<string, ModelOption[]> = {
  anthropic_messages: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  ],
}
