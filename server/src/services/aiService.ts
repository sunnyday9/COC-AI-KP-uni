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
import type { KpToolDef } from '../../../shared/tools/cocTools.js'
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
 *  - Tool-calling support (Task 3): the three protocol adapters accept
 *    `tools` + `onChunk` and return `toolCalls`, matching the original
 *    adapters. The public `chat()` (contract §3) never sends tools; the KP
 *    Agent path goes through `chatForAgent()`.
 *  - doGoogle propagates `_thoughtSignature` both directions (request-side
 *    passthrough + response capture), restoring the original aiHandlers.cjs
 *    behavior that was lost in Task 2 (see task-2-report.md minor).
 */

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

/**
 * OpenAI-format tool definition — single source: shared/tools/cocTools.ts
 * (same shape as the original shared/tools/cocTools.cjs).
 */
export type ChatTool = KpToolDef

/** Normalized tool call emitted by adapters (mirrors original aiHandlers.cjs). */
export interface ToolCallResult {
  id: string
  name: string
  arguments: string
  _thoughtSignature?: string
}

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

/** Internal adapter result — superset of ChatResult with toolCalls. */
interface AdapterResult {
  stream: boolean
  content?: string
  chunks?: string[]
  toolCalls?: ToolCallResult[]
}

type OnChunk = (chunk: string) => void

/* ═══════════════════ OpenAI Compatible (openai SDK) ═══════════════════ */

async function doOpenAICompat(
  config: AIProviderConfig,
  messages: ChatMessage[],
  stream: boolean,
  temp: number,
  maxTokens: number,
  tools?: ChatTool[],
  onChunk?: OnChunk,
): Promise<AdapterResult> {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey || 'not-needed',
  })

  const opts: {
    model: string
    messages: ChatCompletionMessageParam[]
    temperature: number
    max_tokens: number
    stream: boolean
    tools?: ChatTool[]
    tool_choice?: string
  } = {
    model: config.model as string,
    messages: messages as unknown as ChatCompletionMessageParam[],
    temperature: temp ?? 0.7,
    max_tokens: maxTokens ?? 2048,
    stream: !!stream,
  }
  if (tools && tools.length > 0) {
    opts.tools = tools
    opts.tool_choice = 'auto'
  }

  const res = (await client.chat.completions.create(opts as unknown as Parameters<OpenAI['chat']['completions']['create']>[0])) as
    | ChatCompletion
    | AsyncIterable<ChatCompletionChunk>

  if (stream) {
    const chunks: string[] = []
    let fullText = ''
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>()
    for await (const chunk of res as AsyncIterable<ChatCompletionChunk>) {
      const choice = chunk.choices?.[0]
      const delta = choice?.delta?.content
      if (delta) {
        fullText += delta
        chunks.push(delta)
        if (onChunk) onChunk(delta)
      }
      const tcs = choice?.delta?.tool_calls
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = tc.index ?? 0
          const prev = toolCallsByIndex.get(idx) ?? { id: tc.id ?? '', name: '', arguments: '' }
          toolCallsByIndex.set(idx, {
            id: tc.id ?? prev.id,
            name: tc.function?.name ?? prev.name,
            arguments: (prev.arguments ?? '') + (tc.function?.arguments ?? ''),
          })
        }
      }
    }
    const toolCalls: ToolCallResult[] = [...toolCallsByIndex.values()].map((tc, idx) => ({
      id: tc.id ?? `tc_${idx}`,
      name: tc.name ?? '',
      arguments: tc.arguments?.trim() ? tc.arguments : '{}',
    }))
    return {
      stream: true,
      chunks,
      content: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }
  }

  const msg = (res as ChatCompletion).choices?.[0]?.message ?? {}
  const toolCalls: ToolCallResult[] = ((msg as { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }).tool_calls || []).map(
    (tc) => ({
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '{}',
    }),
  )
  return {
    stream: false,
    content: (msg.content as string | null) ?? '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  }
}

/* ═══════════════════ Anthropic Compatible (fetch + SSE) ═══════════════════ */

function toAnthropicTools(openaiTools?: ChatTool[]): unknown[] | undefined {
  if (!openaiTools?.length) return undefined
  interface AnthropicTool {
    name: string
    description: string
    input_schema: Record<string, unknown>
  }
  return openaiTools
    .map((t) => {
      const fn = t.function
      if (!fn) return null
      return {
        name: fn.name,
        description: fn.description ?? '',
        input_schema: fn.parameters ?? { type: 'object', properties: {} },
      }
    })
    .filter((x): x is AnthropicTool => x !== null)
}

function toAnthropicMessages(messages: ChatMessage[]): {
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
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
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
        tool_use_id: m.tool_call_id || '',
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
  messages: ChatMessage[],
  stream: boolean,
  temp: number,
  maxTokens: number,
  tools?: ChatTool[],
  onChunk?: OnChunk,
): Promise<AdapterResult> {
  const apiKey = config.apiKey
  if (!apiKey) throw new BadRequestError('Anthropic 需要 API Key')
  const baseURL = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')

  const { system, messages: anthropicMsgs } = toAnthropicMessages(messages)
  const anthropicTools = toAnthropicTools(tools)

  const body: Record<string, unknown> = {
    model: config.model,
    messages: anthropicMsgs,
    max_tokens: maxTokens ?? 2048,
    temperature: temp ?? 0.7,
    stream: !!stream,
  }
  if (system) body.system = system
  if (anthropicTools?.length) body.tools = anthropicTools

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
    let fullText = ''
    const toolBlocks: ToolCallResult[] = []
    let currentToolId = ''
    let currentToolName = ''
    let currentToolInput = ''

    const reader = res.body?.getReader()
    if (!reader) return { stream: true, chunks, content: fullText }
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
        let evt: { type?: string; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string } }
        try {
          evt = JSON.parse(raw)
        } catch {
          continue
        }

        if (evt.type === 'content_block_start') {
          const block = evt.content_block ?? {}
          if (block.type === 'tool_use') {
            currentToolId = block.id || ''
            currentToolName = block.name || ''
            currentToolInput = ''
          }
        } else if (evt.type === 'content_block_delta') {
          const delta = evt.delta ?? {}
          if (delta.type === 'text_delta' && delta.text) {
            fullText += delta.text
            chunks.push(delta.text)
            if (onChunk) onChunk(delta.text)
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            currentToolInput += delta.partial_json
          }
        } else if (evt.type === 'content_block_stop') {
          if (currentToolName) {
            let parsedInput: unknown = {}
            try {
              parsedInput = JSON.parse(currentToolInput)
            } catch {
              /* ignore */
            }
            toolBlocks.push({
              id: currentToolId,
              name: currentToolName,
              arguments: JSON.stringify(parsedInput),
            })
            currentToolId = ''
            currentToolName = ''
            currentToolInput = ''
          }
        }
      }
    }

    return {
      stream: true,
      chunks,
      content: fullText,
      toolCalls: toolBlocks.length > 0 ? toolBlocks : undefined,
    }
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]
  }
  let text = ''
  const toolCalls: ToolCallResult[] = []
  for (const block of data.content ?? []) {
    if (block.type === 'text') text += block.text ?? ''
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `tc_${toolCalls.length}`,
        name: block.name ?? '',
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }
  return {
    stream: false,
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  }
}

/* ═══════════════════ Google Compatible (fetch + SSE) ═══════════════════ */

function toGeminiTools(openaiTools?: ChatTool[]): unknown[] | null {
  if (!openaiTools?.length) return null

  function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const t = (String(schema?.type ?? 'string')).toLowerCase()
    const base: Record<string, unknown> = {
      type: t === 'object' ? 'OBJECT' : t === 'array' ? 'ARRAY' : t === 'integer' ? 'INTEGER' : t === 'number' ? 'NUMBER' : t === 'boolean' ? 'BOOLEAN' : 'STRING',
      description: String(schema?.description ?? ''),
    }

    if (t === 'array') {
      const itemSchema = (schema?.items as Record<string, unknown>) ?? { type: 'string' }
      base.items = toGeminiSchema(itemSchema)
      return base
    }

    if (t === 'object') {
      const props = (schema?.properties as Record<string, Record<string, unknown>>) ?? {}
      const required = (schema?.required as string[]) ?? []
      const out: Record<string, unknown> = { ...base, properties: {}, required }
      for (const [k, v] of Object.entries(props)) {
        ;(out.properties as Record<string, unknown>)[k] = toGeminiSchema(v)
      }
      return out
    }

    if (Array.isArray(schema?.enum)) {
      base.enum = schema.enum
    }

    return base
  }

  interface GeminiToolDeclaration {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  const declarations = openaiTools
    .map((t) => {
      const fn = t.function
      if (!fn) return null
      const params = (fn.parameters ?? { type: 'object', properties: {}, required: [] }) as Record<string, unknown>
      const geminiParams = toGeminiSchema(params)
      return {
        name: fn.name,
        description: fn.description ?? '',
        parameters: geminiParams,
      }
    })
    .filter((x): x is GeminiToolDeclaration => x !== null)
  return declarations.length ? [{ functionDeclarations: declarations }] : null
}

async function doGoogle(
  config: AIProviderConfig,
  messages: ChatMessage[],
  stream: boolean,
  temp: number,
  maxTokens: number,
  tools?: ChatTool[],
  onChunk?: OnChunk,
): Promise<AdapterResult> {
  const apiKey = config.apiKey
  if (!apiKey) throw new BadRequestError('Google API 需要 API Key')
  let model = (config.model || '').trim()
  if (!model) throw new BadRequestError('请先在设置中选择或输入模型名称')
  model = model.replace(/^models\//, '')

  const baseURL = (config.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')

  const systemMsg = messages.find((m) => m.role === 'system')
  const other = messages.filter((m) => m.role !== 'system')
  const contents: { role: string; parts: Record<string, unknown>[] }[] = []
  let pendingToolNames: string[] = []
  for (const m of other) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      pendingToolNames = m.tool_calls.map((tc) => tc.function?.name ?? '')
      for (const tc of m.tool_calls) {
        let args: unknown = {}
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {})
        } catch {
          /* ignore */
        }
        const partObj: Record<string, unknown> = {
          functionCall: {
            name: tc.function?.name ?? '',
            args,
          },
        }
        // _thoughtSignature passthrough — restored from original aiHandlers.cjs
        if (tc._thoughtSignature) partObj.thoughtSignature = tc._thoughtSignature
        contents.push({ role: 'model', parts: [partObj] })
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
    } else if (m.role === 'assistant' && m.content && !m.tool_calls?.length) {
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
  const geminiTools = toGeminiTools(tools)
  if (geminiTools) body.tools = geminiTools

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
    let fullText = ''
    const geminiToolCalls: ToolCallResult[] = []
    const reader = res.body?.getReader()
    if (!reader) return { stream: true, chunks, content: fullText }
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
        let obj: { candidates?: { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown }; thoughtSignature?: unknown }[] } }[] }
        try {
          obj = JSON.parse(raw)
        } catch {
          continue
        }
        for (const part of obj.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            fullText += part.text
            chunks.push(part.text)
            if (onChunk) onChunk(part.text)
          }
          if (part.functionCall) {
            const tc: ToolCallResult = {
              id: `gemini_tc_${geminiToolCalls.length}`,
              name: part.functionCall.name ?? '',
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            }
            // _thoughtSignature capture — restored from original aiHandlers.cjs
            if (part.thoughtSignature) tc._thoughtSignature = String(part.thoughtSignature)
            geminiToolCalls.push(tc)
          }
        }
      }
    }
    return {
      stream: true,
      chunks,
      content: fullText,
      toolCalls: geminiToolCalls.length > 0 ? geminiToolCalls : undefined,
    }
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown }; thoughtSignature?: unknown }[] } }[]
  }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  let text = ''
  const geminiToolCalls: ToolCallResult[] = []
  for (const part of parts) {
    if (part.text) text += part.text
    if (part.functionCall) {
      const tc: ToolCallResult = {
        id: `gemini_tc_${geminiToolCalls.length}`,
        name: part.functionCall.name ?? '',
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      }
      // _thoughtSignature capture — restored from original aiHandlers.cjs
      if (part.thoughtSignature) tc._thoughtSignature = String(part.thoughtSignature)
      geminiToolCalls.push(tc)
    }
  }
  return {
    stream: false,
    content: text,
    toolCalls: geminiToolCalls.length > 0 ? geminiToolCalls : undefined,
  }
}

/* ═══════════════════ Config resolution & dispatch ═══════════════════ */

/**
 * Resolve the user's AI settings into a provider config, asserting the
 * outbound URL safety gate BEFORE any request is made.
 * `modelOverride` (used by RAG graph extraction) replaces the settings model
 * without requiring settings.ai.model to be set — mirrors the original
 * invokeChat's `model: model || ai.model` precedence.
 */
function resolveAiConfig(userId: number, modelOverride?: string): { config: AIProviderConfig; protocol: string } {
  const ai = getAiConfig(userId)
  const provider = ai.provider as AIProviderType
  if (!provider) throw new BadRequestError('请先在设置中配置 AI 提供商')

  const def = getProviderDef(provider)
  if (!def) throw new BadRequestError(`Unknown provider: ${provider}. 请在设置中选择正确的提供商。`)
  if (!ai.model && !modelOverride) throw new BadRequestError('请先在设置中选择或输入模型名称')
  const baseUrl = (ai.baseUrl || def.defaultBaseUrl || '').replace(/\/$/, '')
  if (!baseUrl) throw new BadRequestError('请在设置中填写 Base URL')

  // Security gate: every outbound AI request must pass this first.
  try {
    assertSafeOutboundUrl(baseUrl)
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err))
  }

  return {
    config: {
      provider,
      model: modelOverride || ai.model,
      baseUrl,
      apiKey: ai.apiKey,
      temperature: ai.temperature,
      maxTokens: ai.maxTokens,
    },
    protocol: def.protocol,
  }
}

function dispatchChat(
  protocol: string,
  config: AIProviderConfig,
  messages: ChatMessage[],
  stream: boolean,
  temp: number,
  maxTokens: number,
  tools?: ChatTool[],
  onChunk?: OnChunk,
): Promise<AdapterResult> {
  if (protocol === 'openai_compatible' || protocol === 'deepseek_compatible') {
    return doOpenAICompat(config, messages, stream, temp, maxTokens, tools, onChunk)
  }
  if (protocol === 'anthropic_compatible') {
    return doAnthropic(config, messages, stream, temp, maxTokens, tools, onChunk)
  }
  if (protocol === 'google_compatible') {
    return doGoogle(config, messages, stream, temp, maxTokens, tools, onChunk)
  }
  throw new BadRequestError(`Unknown protocol: ${protocol}`)
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

  const { config, protocol } = resolveAiConfig(userId)
  const temp = body.temperature ?? config.temperature ?? 0.7
  const maxTokens = body.maxTokens ?? config.maxTokens ?? 2048
  const stream = !!body.stream

  try {
    const result = await dispatchChat(protocol, config, messages, stream, temp, maxTokens)
    // Contract §3 response shape only — strip toolCalls (chat never sends tools).
    if (result.stream) return { stream: true, chunks: result.chunks ?? [] }
    return { stream: false, content: result.content ?? '' }
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('ai chat upstream failure', { provider: config.provider, error: err instanceof Error ? err.message : String(err) })
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
    onChunk?: OnChunk
  },
): Promise<{ content: string; toolCalls?: ToolCallResult[] }> {
  const messages = params.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }

  const { config, protocol } = resolveAiConfig(userId)
  const temp = params.temperature ?? config.temperature ?? 0.7
  const maxTokens = params.maxTokens ?? config.maxTokens ?? 2048
  const stream = !!params.stream

  try {
    const result = await dispatchChat(protocol, config, messages, stream, temp, maxTokens, params.tools, params.onChunk)
    return { content: result.content ?? '', toolCalls: result.toolCalls }
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('kp agent LLM call failure', { provider: config.provider, error: err instanceof Error ? err.message : String(err) })
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

  const { config, protocol } = resolveAiConfig(userId, params.model)
  const temp = params.temperature ?? config.temperature ?? 0.7
  const maxTokens = params.maxTokens ?? config.maxTokens ?? 2048

  try {
    const result = await dispatchChat(protocol, config, messages, false, temp, maxTokens)
    return { content: result.content ?? '' }
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    logger.warn('rag graph LLM call failure', { provider: config.provider, error: err instanceof Error ? err.message : String(err) })
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
