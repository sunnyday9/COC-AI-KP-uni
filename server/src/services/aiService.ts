import {
  AI_MODEL_LISTS,
  resolveProtocolDefaultBaseUrl,
  type AIProviderConfig,
  type LLMProtocol,
  type ModelOption,
} from '../../../shared/constants/providers.js'
import { getAiConfig } from './settingsService.js'
import { isMockAiMode } from '../config.js'
import { mockChat, mockChatForAgent, mockChatForRag, mockListModels } from './mockAi.js'
import { assertSafeOutboundUrl } from '../utils/outboundUrl.js'
import { BadRequestError, UpstreamError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { dispatch } from './llm/index.js'
import type { ChatMessage, ChatTool, ToolCallResult } from './llm/types.js'

/**
 * AI service (api-contract §3) — config resolution + dispatch facade over
 * the llm protocol adapters (ADR-0003). Adapter implementations live in
 * `services/llm/*`; this module resolves the user's settings into a config,
 * asserts the outbound URL gate, and calls `dispatch(config, params)`.
 *
 * Adaptations vs the original aiHandlers.cjs (no Electron main process):
 *  - AI config (protocol/baseUrl/model/apiKey/…) is read server-side from the
 *    user's settings (decrypted apiKey); the request body carries none.
 *  - Every outbound request passes `assertSafeOutboundUrl(baseUrl)` first.
 *  - Streaming (stream=true) returns buffered `{ stream: true, chunks }`
 *    (contract §3); the original collapsed streams into non-stream results.
 *  - Tool-calling (Task 3): adapters accept `tools` + `onChunk` and return
 *    `toolCalls`; the public `chat()` (contract §3) never sends tools; the KP
 *    Agent path goes through `chatForAgent()`.
 */

export type { ChatMessage, ChatTool, ToolCallResult, LLMCallParams, LLMResult } from './llm/types.js'

export interface ChatBody {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatResult {
  stream: boolean
  content?: string
  chunks?: string[]
}

/**
 * Per-request timeout for NON-streaming LLM calls (perf guard). A hung single
 * call would otherwise consume the whole 120s graph budget (kpAgentService
 * GRAPH_TIMEOUT_MS) shared by up to 3 serial calls. Streaming calls are NOT
 * time-limited: chunk activity is the liveness signal and long narratives
 * must not be killed by a fixed clock.
 */
export const LLM_REQUEST_TIMEOUT_MS = 60_000

/** Race a promise against the request timeout (exported for tests). */
export async function withRequestTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`)), LLM_REQUEST_TIMEOUT_MS)
    }),
  ])
}

/* ═══════════════════ Config resolution & dispatch ═══════════════════ */

/**
 * Resolve the user's AI settings into a provider config, asserting the
 * outbound URL safety gate BEFORE any request is made.
 * `modelOverride` (used by RAG graph extraction) replaces the settings model
 * without requiring settings.ai.model to be set — mirrors the original
 * invokeChat's `model: model || ai.model` precedence.
 */
function resolveAiConfig(userId: number, modelOverride?: string): { config: AIProviderConfig; protocol: LLMProtocol } {
  const ai = getAiConfig(userId)
  const protocol = ai.protocol as LLMProtocol
  if (!protocol) throw new BadRequestError('请先在设置中配置 AI 协议')
  if (!ai.model && !modelOverride) throw new BadRequestError('请先在设置中选择或输入模型名称')
  const baseUrl = (ai.baseUrl || resolveProtocolDefaultBaseUrl(protocol)).replace(/\/$/, '')
  if (!baseUrl) throw new BadRequestError('请在设置中填写 Base URL')

  // Security gate: every outbound AI request must pass this first.
  try {
    assertSafeOutboundUrl(baseUrl)
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err))
  }

  return {
    config: {
      protocol,
      model: modelOverride || ai.model,
      baseUrl,
      apiKey: ai.apiKey,
      temperature: ai.temperature,
      maxTokens: ai.maxTokens,
    },
    protocol,
  }
}

function validateMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }
  for (const m of messages) {
    if (
      typeof m !== 'object' ||
      m === null ||
      typeof (m as { role?: unknown }).role !== 'string' ||
      typeof (m as { content?: unknown }).content !== 'string'
    ) {
      throw new BadRequestError('each message must have a string role and content')
    }
  }
  return messages as ChatMessage[]
}

/**
 * Chat with the user's configured provider. Config comes from the server-side
 * settings (apiKey decrypted); request body carries only messages/tuning.
 * MOCK_AI=1 (Task 11): short-circuits to the deterministic mock provider
 * BEFORE touching settings — no API key / model / baseUrl required.
 */
export async function chat(userId: number, body: ChatBody): Promise<ChatResult> {
  const messages = validateMessages(body.messages)
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature))) {
    throw new BadRequestError('temperature must be a number')
  }
  if (
    body.maxTokens !== undefined &&
    (typeof body.maxTokens !== 'number' || !Number.isInteger(body.maxTokens) || body.maxTokens < 1)
  ) {
    throw new BadRequestError('maxTokens must be a positive integer')
  }

  if (isMockAiMode()) {
    return mockChat(body)
  }

  const { config } = resolveAiConfig(userId)
  const temp = body.temperature ?? config.temperature ?? 0.7
  const maxTokens = body.maxTokens ?? config.maxTokens ?? 2048
  const stream = !!body.stream

  try {
    const result = stream
      ? await dispatch(config, { messages, stream, temperature: temp, maxTokens })
      : await withRequestTimeout(dispatch(config, { messages, stream, temperature: temp, maxTokens }), 'ai chat')
    // Contract §3 response shape only — strip toolCalls (chat never sends tools).
    if (result.stream) return { stream: true, chunks: result.chunks ?? [] }
    return { stream: false, content: result.content ?? '' }
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('ai chat upstream failure', { protocol: config.protocol, error: err instanceof Error ? err.message : String(err) })
    throw new UpstreamError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Agent-path chat (Task 3 KP graph): like `chat()` but accepts OpenAI-format
 * `tools` and an `onChunk` streaming callback, and returns the normalized
 * `{ content, toolCalls }` the graph consumes. Every outbound request passes
 * assertSafeOutboundUrl via resolveAiConfig.
 */
export async function chatForAgent(
  userId: number,
  params: {
    messages: ChatMessage[]
    temperature?: number
    maxTokens?: number
    stream?: boolean
    tools?: ChatTool[]
    onChunk?: (chunk: string) => void
  },
): Promise<{ content: string; toolCalls?: ToolCallResult[] }> {
  const messages = params.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }

  if (isMockAiMode()) {
    // Deterministic script drives the real kpGraph: classifier keyword,
    // keyword→toolCalls sequences and tool-continuation chains (mockAi.ts).
    return mockChatForAgent(messages, !!params.stream, params.onChunk)
  }

  const { config } = resolveAiConfig(userId)
  const temp = params.temperature ?? config.temperature ?? 0.7
  const maxTokens = params.maxTokens ?? config.maxTokens ?? 2048
  const stream = !!params.stream

  try {
    const result = stream
      ? await dispatch(config, { messages, stream, temperature: temp, maxTokens, tools: params.tools, onChunk: params.onChunk })
      : await withRequestTimeout(
          dispatch(config, { messages, stream, temperature: temp, maxTokens, tools: params.tools, onChunk: params.onChunk }),
          'kp agent LLM',
        )
    return { content: result.content ?? '', toolCalls: result.toolCalls }
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('kp agent LLM call failure', { protocol: config.protocol, error: err instanceof Error ? err.message : String(err) })
    throw new UpstreamError(err instanceof Error ? err.message : String(err))
  }
}

/* ═══════════════════ Model listing ═══════════════════ */

/**
 * RAG-path chat (Task 4 GraphRAG extraction / community summaries): like
 * `chatForAgent` but non-streaming only and with a `model` override that
 * takes precedence over settings.ai.model (mirrors the original invokeChat
 * used by ragHandlers.cjs: `model: model || ai.model`). Every outbound
 * request passes assertSafeOutboundUrl via resolveAiConfig.
 */
export async function chatForRag(
  userId: number,
  params: {
    messages: ChatMessage[]
    model?: string
    temperature?: number
    maxTokens?: number
  },
): Promise<{ content: string }> {
  const messages = params.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }

  if (isMockAiMode()) {
    // Fixed parseable output keeps graph extraction / community summaries
    // working without an LLM (parseExtractOutput tolerates garbage → empty).
    return mockChatForRag()
  }

  const { config } = resolveAiConfig(userId, params.model)
  const temp = params.temperature ?? config.temperature ?? 0.7
  const maxTokens = params.maxTokens ?? config.maxTokens ?? 2048

  try {
    const result = await withRequestTimeout(
      dispatch(config, { messages, stream: false, temperature: temp, maxTokens }),
      'rag graph LLM',
    )
    return { content: result.content ?? '' }
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('rag graph LLM call failure', { protocol: config.protocol, error: err instanceof Error ? err.message : String(err) })
    throw new UpstreamError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * List models for the user's configured provider (api-contract §3).
 * Same behavior as original aiHandlers.listModels / modelListService:
 *  - openai/deepseek compatible → GET {baseUrl}/models (empty on failure)
 *  - anthropic compatible → static preset list (AI_MODEL_LISTS)
 *  - google compatible → GET /v1beta/models (empty on failure)
 * Every fetch is preceded by assertSafeOutboundUrl.
 */
export async function listModels(userId: number, purpose = 'chat'): Promise<ModelOption[]> {
  if (isMockAiMode()) {
    // One deterministic option so the settings page model picker works.
    return mockListModels()
  }
  const ai = getAiConfig(userId)
  const protocol = ai.protocol as LLMProtocol
  if (!protocol) return []
  const baseUrl = (ai.baseUrl || resolveProtocolDefaultBaseUrl(protocol)).replace(/\/$/, '')
  const apiKey = ai.apiKey

  if (protocol === 'openai_chat' || protocol === 'openai_responses') {
    if (!baseUrl) return []
    try {
      assertSafeOutboundUrl(baseUrl)
      const modelsUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`
      const headers: Record<string, string> = {}
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const res = await fetch(modelsUrl, { headers })
      if (!res.ok) return []
      const data = (await res.json()) as { data?: { id: string }[] }
      let models: ModelOption[] = (data.data ?? []).filter((m) => m.id).map((m) => ({ value: m.id, label: m.id }))
      if (purpose === 'embeddings') {
        const filtered = models.filter((m) => /(embedding|embed)/i.test(m.value))
        if (filtered.length) models = filtered
      }
      return models.slice(0, 100)
    } catch {
      return []
    }
  }

  if (protocol === 'anthropic_messages') {
    if (purpose === 'embeddings') return []
    return AI_MODEL_LISTS.anthropic_compatible ?? []
  }

  if (protocol === 'google_compatible') {
    if (!apiKey) return []
    const base = baseUrl || 'https://generativelanguage.googleapis.com'
    try {
      assertSafeOutboundUrl(base)
      const res = await fetch(`${base}/v1beta/models?key=${apiKey}&pageSize=100`)
      if (!res.ok) return []
      const data = (await res.json()) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]
      }
      const models = data.models ?? []
      const chatFiltered = models.filter(
        (m) => m.name && (m.supportedGenerationMethods ?? []).includes('generateContent'),
      )
      const embedFiltered = models.filter((m) => {
        const methods = m.supportedGenerationMethods ?? []
        return m.name && (methods.includes('embedContent') || methods.includes('embedText') || methods.includes('embedding'))
      })
      const finalList =
        purpose === 'embeddings' ? (embedFiltered.length ? embedFiltered : chatFiltered) : chatFiltered
      return finalList.map((m) => {
        const id = (m.name ?? '').replace('models/', '') || (m.name ?? '')
        return { value: id, label: m.displayName || id }
      })
    } catch {
      return []
    }
  }

  return []
}
