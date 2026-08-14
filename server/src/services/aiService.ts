import OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions.js'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js'
import {
  AI_MODEL_LISTS,
  getProviderDef,
  type AIProviderConfig,
  type AIProviderType,
  type ModelOption,
} from '../../../shared/constants/providers.js'
import { getAiConfig } from './settingsService.js'
import { assertSafeOutboundUrl } from '../utils/outboundUrl.js'
import { BadRequestError, UpstreamError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

/**
 * AI service (api-contract §3) — migrated from
 * `original/ai-trpg-web/electron/ipc/aiHandlers.cjs` (Provider → Protocol
 * resolver + doOpenAICompat / doAnthropic / doGoogle + listModels).
 *
 * Adaptations vs the original (no Electron main process):
 *  - AI config (provider/baseUrl/model/apiKey/…) is read server-side from the
 *    user's settings (decrypted apiKey); the request body carries none.
 *  - Every outbound request passes `assertSafeOutboundUrl(baseUrl)` first.
 *  - Streaming (stream=true) returns buffered `{ stream: true, chunks }`
 *    (contract §3); the original collapsed streams into non-stream results.
 *  - Tool-calling support is deferred to Task 3 (KP Agent); chat() sends no
 *    `tools`, so responses carry content only (contract §3 response shape).
 */

export interface ChatBody {
  messages: { role: string; content: string }[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatResult {
  stream: boolean
  content?: string
  chunks?: string[]
}

/* ═══════════════════ OpenAI Compatible (openai SDK) ═══════════════════ */

async function doOpenAICompat(
  config: AIProviderConfig,
  messages: { role: string; content: string }[],
  stream: boolean,
  temp: number,
  maxTokens: number,
): Promise<ChatResult> {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey || 'not-needed',
  })

  const opts = {
    model: config.model as string,
    messages: messages as unknown as ChatCompletionMessageParam[],
    temperature: temp ?? 0.7,
    max_tokens: maxTokens ?? 2048,
    stream,
  }

  const res = (await client.chat.completions.create(opts)) as ChatCompletion | AsyncIterable<ChatCompletionChunk>

  if (stream) {
    const chunks: string[] = []
    for await (const chunk of res as AsyncIterable<ChatCompletionChunk>) {
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) chunks.push(delta)
    }
    return { stream: true, chunks }
  }

  const msg = (res as ChatCompletion).choices?.[0]?.message ?? {}
  return { stream: false, content: msg.content ?? '' }
}

/* ═══════════════════ Anthropic Compatible (fetch + SSE) ═══════════════════ */

function toAnthropicMessages(messages: { role: string; content: string }[]): {
  system: string
  messages: unknown[]
} {
  const system: string[] = []
  const raw: { role: string; content: unknown }[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content || '')
      continue
    }
    if (m.role === 'user') {
      raw.push({ role: 'user', content: m.content || '' })
    } else if (m.role === 'assistant') {
      const blocks: unknown[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      const toolCalls = (m as unknown as { tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }).tool_calls
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          let input: unknown = {}
          try {
            input =
              typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments ?? {})
          } catch {
            /* ignore malformed arguments */
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id || `tc_${Date.now()}`,
            name: tc.function?.name ?? '',
            input,
          })
        }
      }
      if (blocks.length > 0) raw.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool') {
      const last = raw[raw.length - 1]
      const result = {
        type: 'tool_result',
        tool_use_id: (m as { tool_call_id?: string }).tool_call_id || '',
        content: m.content || '',
      }
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(result)
      } else {
        raw.push({ role: 'user', content: [result] })
      }
    }
  }

  const msgs: { role: string; content: unknown }[] = []
  for (const m of raw) {
    const prev = msgs[msgs.length - 1]
    if (prev && prev.role === m.role) {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content || '' }]
      const curBlocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }]
      prev.content = (prevBlocks as unknown[]).concat(curBlocks as unknown[])
    } else {
      msgs.push({ ...m })
    }
  }

  if (msgs.length > 0 && msgs[0].role !== 'user') {
    msgs.unshift({ role: 'user', content: '（继续）' })
  }

  return { system: system.join('\n\n'), messages: msgs }
}

async function doAnthropic(
  config: AIProviderConfig,
  messages: { role: string; content: string }[],
  stream: boolean,
  temp: number,
  maxTokens: number,
): Promise<ChatResult> {
  const apiKey = config.apiKey
  if (!apiKey) throw new BadRequestError('Anthropic 需要 API Key')
  const baseURL = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')

  const { system, messages: anthropicMsgs } = toAnthropicMessages(messages)
  const body: Record<string, unknown> = {
    model: config.model,
    messages: anthropicMsgs,
    max_tokens: maxTokens ?? 2048,
    temperature: temp ?? 0.7,
    stream,
  }
  if (system) body.system = system

  const res = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Anthropic: ${res.status} ${errText}`)
  }

  if (stream) {
    const chunks: string[] = []
    const reader = res.body?.getReader()
    if (!reader) return { stream: true, chunks }
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') continue
        let evt: { type?: string; delta?: { type?: string; text?: string } }
        try {
          evt = JSON.parse(raw)
        } catch {
          continue
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          chunks.push(evt.delta.text)
        }
      }
    }
    return { stream: true, chunks }
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  let text = ''
  for (const block of data.content ?? []) {
    if (block.type === 'text') text += block.text ?? ''
  }
  return { stream: false, content: text }
}

/* ═══════════════════ Google Compatible (fetch + SSE) ═══════════════════ */

async function doGoogle(
  config: AIProviderConfig,
  messages: { role: string; content: string }[],
  stream: boolean,
  temp: number,
  maxTokens: number,
): Promise<ChatResult> {
  const apiKey = config.apiKey
  if (!apiKey) throw new BadRequestError('Google API 需要 API Key')
  let model = (config.model || '').trim()
  if (!model) throw new BadRequestError('请先在设置中选择或输入模型名称')
  model = model.replace(/^models\//, '')

  const baseURL = (config.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')

  const systemMsg = messages.find((m) => m.role === 'system')
  const other = messages.filter((m) => m.role !== 'system')
  const contents: { role: string; parts: unknown[] }[] = []
  let pendingToolNames: string[] = []
  for (const m of other) {
    const toolCalls = (m as unknown as { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }).tool_calls
    if (m.role === 'assistant' && toolCalls?.length) {
      pendingToolNames = toolCalls.map((tc) => tc.function?.name ?? '')
      for (const tc of toolCalls) {
        let args: unknown = {}
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {})
        } catch {
          /* ignore */
        }
        contents.push({ role: 'model', parts: [{ functionCall: { name: tc.function?.name ?? '', args } }] })
      }
      if (m.content) {
        contents.push({ role: 'model', parts: [{ text: m.content }] })
      }
    } else if (m.role === 'tool') {
      const name = pendingToolNames.shift() ?? 'unknown'
      contents.push({
        role: 'function',
        parts: [
          {
            functionResponse: {
              name,
              response: { content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') },
            },
          },
        ],
      })
    } else if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content ?? '' }] })
      pendingToolNames = []
    } else if (m.role === 'assistant' && m.content && !toolCalls?.length) {
      contents.push({ role: 'model', parts: [{ text: m.content }] })
      pendingToolNames = []
    }
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: temp ?? 0.7,
      maxOutputTokens: maxTokens ?? 2048,
    },
  }
  if (systemMsg?.content) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] }
  }

  const endpoint = stream ? 'streamGenerateContent' : 'generateContent'
  const altParam = stream ? '&alt=sse' : ''
  const url = `${baseURL}/v1beta/models/${model}:${endpoint}?key=${apiKey}${altParam}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    const msg = res.status === 404
      ? `Google: 404 模型不存在或已下线 (当前: ${model})`
      : `Google: ${res.status} ${text}`
    throw new Error(msg)
  }

  if (stream) {
    const chunks: string[] = []
    const reader = res.body?.getReader()
    if (!reader) return { stream: true, chunks }
    const decoder = new TextDecoder()
    let sseBuffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuffer += decoder.decode(value, { stream: true })
      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        let obj: { candidates?: { content?: { parts?: { text?: string }[] } }[] }
        try {
          obj = JSON.parse(raw)
        } catch {
          continue
        }
        for (const part of obj.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) chunks.push(part.text)
        }
      }
    }
    return { stream: true, chunks }
  }

  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  let text = ''
  for (const part of parts) {
    if (part.text) text += part.text
  }
  return { stream: false, content: text }
}

/* ═══════════════════ Unified chat ═══════════════════ */

function validateMessages(messages: unknown): { role: string; content: string }[] {
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
  return messages as { role: string; content: string }[]
}

/**
 * Chat with the user's configured provider. Config comes from the server-side
 * settings (apiKey decrypted); request body carries only messages/tuning.
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

  const ai = getAiConfig(userId)
  const provider = ai.provider as AIProviderType
  if (!provider) throw new BadRequestError('请先在设置中配置 AI 提供商')

  const def = getProviderDef(provider)
  if (!def) throw new BadRequestError(`Unknown provider: ${provider}. 请在设置中选择正确的提供商。`)
  if (!ai.model) throw new BadRequestError('请先在设置中选择或输入模型名称')
  const baseUrl = (ai.baseUrl || def.defaultBaseUrl || '').replace(/\/$/, '')
  if (!baseUrl) throw new BadRequestError('请在设置中填写 Base URL')

  // Security gate: every outbound AI request must pass this first.
  try {
    assertSafeOutboundUrl(baseUrl)
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err))
  }

  const config: AIProviderConfig = {
    provider,
    model: ai.model,
    baseUrl,
    apiKey: ai.apiKey,
    temperature: ai.temperature,
    maxTokens: ai.maxTokens,
  }
  const temp = body.temperature ?? ai.temperature ?? 0.7
  const maxTokens = body.maxTokens ?? ai.maxTokens ?? 2048
  const stream = !!body.stream

  try {
    const protocol = def.protocol
    if (protocol === 'openai_compatible' || protocol === 'deepseek_compatible') {
      return await doOpenAICompat(config, messages, stream, temp, maxTokens)
    }
    if (protocol === 'anthropic_compatible') {
      return await doAnthropic(config, messages, stream, temp, maxTokens)
    }
    if (protocol === 'google_compatible') {
      return await doGoogle(config, messages, stream, temp, maxTokens)
    }
    throw new BadRequestError(`Unknown protocol: ${protocol}`)
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('ai chat upstream failure', { provider, error: err instanceof Error ? err.message : String(err) })
    throw new UpstreamError(err instanceof Error ? err.message : String(err))
  }
}

/* ═══════════════════ Model listing ═══════════════════ */

/**
 * List models for the user's configured provider (api-contract §3).
 * Same behavior as original aiHandlers.listModels / modelListService:
 *  - openai/deepseek compatible → GET {baseUrl}/models (empty on failure)
 *  - anthropic compatible → static preset list (AI_MODEL_LISTS)
 *  - google compatible → GET /v1beta/models (empty on failure)
 * Every fetch is preceded by assertSafeOutboundUrl.
 */
export async function listModels(userId: number, purpose = 'chat'): Promise<ModelOption[]> {
  const ai = getAiConfig(userId)
  const provider = ai.provider as AIProviderType
  if (!provider) return []
  const def = getProviderDef(provider)
  if (!def) return []
  const protocol = def.protocol
  const baseUrl = (ai.baseUrl || def.defaultBaseUrl || '').replace(/\/$/, '')
  const apiKey = ai.apiKey

  if (protocol === 'openai_compatible' || protocol === 'deepseek_compatible') {
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

  if (protocol === 'anthropic_compatible') {
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
