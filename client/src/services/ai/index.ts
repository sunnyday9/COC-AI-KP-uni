export { chat, isStreamResponse, consumeStream } from './aiService'
export type { AIProviderConfig, AIProviderType, PresetProvider, CustomProvider, CompatibleProtocol, ChatMessage, ChatRequest, ChatResponse, ChatStream } from './types'
export { PRESET_PROVIDERS, CUSTOM_PROVIDERS, getProviderDef, resolveProtocol, resolveBaseUrl } from './types'
