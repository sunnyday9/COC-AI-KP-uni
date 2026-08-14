/**
 * AI provider constants — migrated verbatim from
 * `original/ai-trpg-web/src/services/ai/types.ts`, plus:
 *  - `ALL_PROVIDER_IDS` (from `original/ai-trpg-web/src/stores/settingsStore.ts`)
 *  - `AI_MODEL_LISTS` (preset model lists, extracted from
 *    `original/ai-trpg-web/electron/ipc/aiHandlers.cjs` listModels()
 *    anthropic branch — the only static preset list in the original app)
 *
 * Shared by server (Task 2+, provider validation / AI calls) and client
 * (Task 6+, Settings UI). Do not edit unilaterally.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
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

/** Preset providers with predefined base URLs */
export type PresetProvider =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'gemini'
  | 'vllm'
  | 'ollama'

/** Custom/generic compatible types for user-defined endpoints */
export type CustomProvider =
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'google_compatible'
  | 'deepseek_compatible'

export type AIProviderType = PresetProvider | CustomProvider

/** The 4 underlying protocol types that all providers route to */
export type CompatibleProtocol =
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'google_compatible'
  | 'deepseek_compatible'

export interface ProviderPreset {
  id: PresetProvider
  label: string
  description: string
  protocol: CompatibleProtocol
  defaultBaseUrl: string
  needsApiKey: boolean
  needsBaseUrl: boolean
  apiKeyPlaceholder: string
}

export interface CustomProviderDef {
  id: CustomProvider
  label: string
  description: string
  protocol: CompatibleProtocol
  defaultBaseUrl: string
  apiKeyPlaceholder: string
}

export const PRESET_PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o、o1 等 OpenAI 官方模型',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsApiKey: true,
    needsBaseUrl: false,
    apiKeyPlaceholder: 'sk-...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '聚合多家模型的统一 API 网关',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsApiKey: true,
    needsBaseUrl: false,
    apiKeyPlaceholder: 'sk-or-...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方 API（V3/R1 等）',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    needsApiKey: true,
    needsBaseUrl: false,
    apiKeyPlaceholder: 'sk-...',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini 系列模型（Google AI Studio）',
    protocol: 'google_compatible',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    needsApiKey: true,
    needsBaseUrl: false,
    apiKeyPlaceholder: 'AIza...',
  },
  {
    id: 'vllm',
    label: 'vLLM (本地)',
    description: '本地 vLLM 推理服务器',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'http://localhost:8000/v1',
    needsApiKey: false,
    needsBaseUrl: true,
    apiKeyPlaceholder: '',
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    description: '本地 Ollama 模型服务',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    needsApiKey: false,
    needsBaseUrl: true,
    apiKeyPlaceholder: '',
  },
]

export const CUSTOM_PROVIDERS: CustomProviderDef[] = [
  {
    id: 'openai_compatible',
    label: 'OpenAI 兼容',
    description: '任何 OpenAI 兼容 API 端点',
    protocol: 'openai_compatible',
    defaultBaseUrl: '',
    apiKeyPlaceholder: 'sk-...',
  },
  {
    id: 'anthropic_compatible',
    label: 'Anthropic 兼容',
    description: 'Claude 系列及 Anthropic 兼容 API',
    protocol: 'anthropic_compatible',
    defaultBaseUrl: 'https://api.anthropic.com',
    apiKeyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'google_compatible',
    label: 'Google 兼容',
    description: 'Gemini API 兼容端点',
    protocol: 'google_compatible',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    apiKeyPlaceholder: 'AIza...',
  },
  {
    id: 'deepseek_compatible',
    label: 'DeepSeek 兼容',
    description: 'DeepSeek 兼容 API（OpenAI 格式）',
    protocol: 'deepseek_compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyPlaceholder: 'sk-...',
  },
]

export function getProviderDef(id: AIProviderType): (ProviderPreset | CustomProviderDef) | undefined {
  return (PRESET_PROVIDERS as (ProviderPreset | CustomProviderDef)[]).find((p) => p.id === id) ??
    CUSTOM_PROVIDERS.find((p) => p.id === id)
}

export function resolveProtocol(id: AIProviderType): CompatibleProtocol {
  const def = getProviderDef(id)
  return def?.protocol ?? 'openai_compatible'
}

export function resolveBaseUrl(id: AIProviderType, userBaseUrl?: string): string {
  const def = getProviderDef(id)
  return userBaseUrl || def?.defaultBaseUrl || ''
}

export interface AIProviderConfig {
  provider: AIProviderType
  baseUrl?: string
  model?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}

/** All valid provider ids (preset + custom). Used for settings validation. */
export const ALL_PROVIDER_IDS = new Set<string>([
  ...PRESET_PROVIDERS.map((p) => p.id),
  ...CUSTOM_PROVIDERS.map((p) => p.id),
])

export interface ModelOption {
  value: string
  label: string
}

/**
 * Preset model lists per provider id. The original app only ships a static
 * list for Anthropic-compatible endpoints; all other providers fetch models
 * from their API at runtime (see server aiService.listModels).
 */
export const AI_MODEL_LISTS: Record<string, ModelOption[]> = {
  anthropic_compatible: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  ],
}
