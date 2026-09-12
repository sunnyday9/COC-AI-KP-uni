import type { LLMProtocol } from '../constants/providers.js'

/**
 * App settings types — mirrors docs/api-contract.md §2 (Settings).
 * Replaces electron-store in the new architecture; stored server-side per user.
 */

export interface AIProviderConfig {
  /** LLM 接入协议（ADR-0003 一等公民） */
  protocol: LLMProtocol
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
  /** 检索补充层总开关（ADR-0007 决策 5/6；默认开）。关闭 = 每回合不检索、
   *  提示词不出现《原文片段》小节。M1 只留这一个总开关，参数硬编默认。 */
  supplement?: boolean
}

export interface AppSettings {
  ai: AIProviderConfig
  rag?: RAGSettings
}
