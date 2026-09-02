/**
 * Google Gemini 适配器（generateContent / streamGenerateContent）— 迁移自
 * `services/aiService.ts` doGoogle（原始 aiHandlers.cjs doGoogle）。
 * 协议私有转换：system → systemInstruction；函数调用 ↔ functionCall；
 * `_thoughtSignature` 双向透传（request passthrough + response capture，
 * 恢复原始 aiHandlers.cjs 行为）。
 */
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'
import { BadRequestError } from '../../utils/errors.js'
import type { ChatMessage, ChatTool, LLMCallParams, LLMResult, ToolCallResult } from './types.js'

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

export async function googleAdapter(config: AIProviderConfig, params: LLMCallParams): Promise<LLMResult> {
  const { messages, tools, onChunk, temperature, maxTokens, stream } = params
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
      temperature: temperature ?? 0.7,
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
        const content = obj.candidates?.[0]?.content
        const contentObj = Array.isArray(content) ? content[0] : content
        for (const part of contentObj?.parts ?? []) {
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
  const content = data.candidates?.[0]?.content
  const contentObj = Array.isArray(content) ? content[0] : content
  const parts = contentObj?.parts ?? []
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
