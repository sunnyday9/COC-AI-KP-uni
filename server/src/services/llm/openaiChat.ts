/**
 * OpenAI Chat Completions 适配器（/v1/chat/completions）— 迁移自
 * `services/aiService.ts` doOpenAICompat（原始 aiHandlers.cjs doOpenAICompat）。
 * 协议私有转换：system 作为 role:system 消息直传；工具 OpenAI 嵌套格式。
 */
import OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions.js'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js'
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'
import type { ChatMessage, ChatTool, LLMCallParams, LLMResult, ToolCallResult } from './types.js'

export async function openaiChatAdapter(config: AIProviderConfig, params: LLMCallParams): Promise<LLMResult> {
  const { messages, tools, onChunk, temperature, maxTokens, stream } = params
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
    temperature: temperature ?? 0.7,
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
