/**
 * Anthropic Messages 适配器（/v1/messages）— 迁移自 `services/aiService.ts`
 * doAnthropic（原始 aiHandlers.cjs doAnthropic）。fetch + SSE 手写解析。
 * 协议私有转换：system 抽取为顶层数组；assistant tool_calls → tool_use 块；
 * tool 结果回填为 user 消息内的 tool_result（多轮历史折叠进相邻 user）。
 */
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'
import { BadRequestError } from '../../utils/errors.js'
import type { ChatMessage, ChatTool, LLMCallParams, LLMResult, ToolCallResult } from './types.js'

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

export async function anthropicMessagesAdapter(
  config: AIProviderConfig,
  params: LLMCallParams,
): Promise<LLMResult> {
  const { messages, tools, onChunk, temperature, maxTokens, stream } = params
  const apiKey = config.apiKey
  if (!apiKey) throw new BadRequestError('Anthropic 需要 API Key')
  // 兼容两种 baseUrl 语义：`https://api.anthropic.com`（官方）与
  // `https://.../v1`（中转站常带 /v1）；统一拼到 /v1/messages。
  const baseURL = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  const messagesUrl = baseURL.endsWith('/v1') ? `${baseURL}/messages` : `${baseURL}/v1/messages`

  const { system, messages: anthropicMsgs } = toAnthropicMessages(messages)
  const anthropicTools = toAnthropicTools(tools)

  const body: Record<string, unknown> = {
    model: config.model,
    messages: anthropicMsgs,
    max_tokens: maxTokens ?? 2048,
    temperature: temperature ?? 0.7,
    stream: !!stream,
  }
  if (system) body.system = system
  if (anthropicTools?.length) body.tools = anthropicTools

  const res = await fetch(messagesUrl, {
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
