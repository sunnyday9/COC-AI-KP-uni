/**
 * OpenAI Responses 适配器（/v1/responses）— 新增（T3 #10，ADR-0003）。
 * 用 openai SDK `client.responses.create`。
 *
 * 协议私有转换：
 *  - system 消息 → `instructions` 字段（responses 无 role:system 消息）
 *  - 工具扁平化：chat 嵌套 {type, function:{...}} → responses 扁平
 *    {type:'function', name, description, parameters}
 *  - maxTokens → `max_output_tokens`（responses 字段名不同）
 *  - 非流式：output 里 message.content[].text 拼接文本；function_call 项
 *    直接拿完整 arguments
 *  - 流式：消费 raw stream（SDK Stream<ResponseStreamEvent>）——
 *    `response.output_text.delta` 累积 content/chunks；function_call 在
 *    `response.output_item.done` 拿到完整 arguments（Q8-A：不做流式
 *    arguments delta 拼装，KP 无中间消费方）
 *
 * 注意：responses 的 assistant 工具调用在下一轮以
 * {type:'function_call_output', call_id, output} 形式回传（input 数组携带），
 * 本适配器单次往返语义下由调用方（kpAgentService 循环）负责携带。
 */
import OpenAI from 'openai'
import type { AIProviderConfig } from '../../../../shared/constants/providers.js'
import type { ChatMessage, ChatTool, LLMCallParams, LLMResult, ToolCallResult } from './types.js'

/** chat 嵌套工具 → responses 扁平工具 */
function toResponsesTools(tools?: ChatTool[]): unknown[] | undefined {
  if (!tools?.length) return undefined
  const out: unknown[] = []
  for (const t of tools) {
    const fn = t.function
    if (!fn) continue
    out.push({
      type: 'function',
      name: fn.name,
      description: fn.description ?? '',
      parameters: fn.parameters ?? { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/** OpenAI 风格消息 → responses input items（system 抽到 instructions） */
function toResponsesInput(messages: ChatMessage[]): { input: unknown[]; instructions?: string } {
  const system: string[] = []
  const input: unknown[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content || '')
      continue
    }
    if (m.role === 'user') {
      input.push({ role: 'user', content: m.content || '' })
    } else if (m.role === 'assistant') {
      // responses input 不接受裸 {role:'assistant'} 消息（合法 role 仅
      // user/system/developer）；assistant 历史必须以 ResponseOutputMessage
      // 形态（type:'message', role:'assistant'）或 function_call item 携带。
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        })
      }
      // 上一轮 assistant 发起的工具调用 → function_call items（后续 tool
      // 结果以 function_call_output 配对，顺序保证 call_id 先于 output）
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id || `fc_${input.length}`,
          name: tc.function?.name ?? '',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        })
      }
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      })
    }
  }

  return { input, instructions: system.length > 0 ? system.join('\n\n') : undefined }
}

export async function openaiResponsesAdapter(
  config: AIProviderConfig,
  params: LLMCallParams,
): Promise<LLMResult> {
  const { messages, tools, onChunk, temperature, maxTokens, stream } = params
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey || 'not-needed',
  })

  const { input, instructions } = toResponsesInput(messages)
  const body: Record<string, unknown> = {
    model: config.model,
    input,
    max_output_tokens: maxTokens ?? 2048,
    temperature: temperature ?? 0.7,
    stream: !!stream,
  }
  if (instructions) body.instructions = instructions
  const responsesTools = toResponsesTools(tools)
  if (responsesTools?.length) body.tools = responsesTools

  const res = (await client.responses.create(
    body as unknown as Parameters<OpenAI['responses']['create']>[0],
  )) as unknown as {
    output?: {
      type?: string
      content?: { type?: string; text?: string }[]
      name?: string
      arguments?: string
      call_id?: string
    }[]
  } & AsyncIterable<{
    type?: string
    delta?: string
    item?: {
      type?: string
      call_id?: string
      name?: string
      arguments?: string
      status?: string
    }
  }>

  if (stream) {
    const chunks: string[] = []
    let fullText = ''
    const toolCalls: ToolCallResult[] = []
    // stream 返回的是 SDK Stream（AsyncIterable<ResponseStreamEvent>）
    for await (const evt of res as AsyncIterable<{
      type?: string
      delta?: string
      item?: { type?: string; call_id?: string; name?: string; arguments?: string; status?: string }
    }>) {
      if (evt.type === 'response.output_text.delta' && evt.delta) {
        fullText += evt.delta
        chunks.push(evt.delta)
        if (onChunk) onChunk(evt.delta)
      }
      // function_call 完成事件（output_item.done）携带完整 arguments
      if (evt.type === 'response.output_item.done' && evt.item?.type === 'function_call') {
        toolCalls.push({
          id: evt.item.call_id || '',
          name: evt.item.name || '',
          arguments: evt.item.arguments ?? '{}',
        })
      }
    }
    return {
      stream: true,
      chunks,
      content: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }
  }

  // 非流式
  const output = (res as { output?: { type?: string; content?: { type?: string; text?: string }[]; name?: string; arguments?: string; call_id?: string }[] }).output ?? []
  let text = ''
  const toolCalls: ToolCallResult[] = []
  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) text += part.text
      }
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? `fc_${toolCalls.length}`,
        name: item.name ?? '',
        arguments: item.arguments ?? '{}',
      })
    }
  }
  return {
    stream: false,
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  }
}
