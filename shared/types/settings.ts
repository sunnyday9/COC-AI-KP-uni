/**
 * App settings types — mirrors docs/api-contract.md §2 (Settings).
 * Replaces electron-store in the new architecture; stored server-side per user.
 */

export interface AIProviderConfig {
  /** 'openai' | 'deepseek' | 'custom' | ... (见 PRESET_PROVIDERS) */
  provider: string
  baseUrl: string
  model: string
  /** 服务端 AES-256 加密存储；GET 不回传 */
  apiKey?: string
  temperature: number
  maxTokens: number
}

export interface RAGSettings {
  useEmbeddings: boolean
  provider: 'builtin' | 'api'
  /** 默认 'text-embedding-3-small' */
  model: string
  useGraphRAG?: boolean
  extractionModel?: string
}

export interface AppSettings {
  ai: AIProviderConfig
  rag?: RAGSettings
  syncServerUrl: string
  debugMode?: boolean
}
