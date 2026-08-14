/**
 * KP 会话服务：负责单次 KP 调用、Agent 工具循环与直连对话。
 * 与后端 KP/LangGraph 及 AI chat 端点交互（经 Platform Bridge），
 * 工具执行由调用方（gameStore）通过 processToolCalls 注入。
 */
import { chat, isStreamResponse } from './ai'
import type { AIProviderConfig } from './ai'
import type { StoryContext } from '../types/storyContext'
import { traceBus } from './tracing'
import { getBridge } from '../platform'

export type ToolCall = { id: string; name: string; arguments: string }

export interface KpAgentCallbacks {
  /** 处理本轮工具调用，返回 toolResults 与展示用消息 */
  processToolCalls: (toolCalls: ToolCall[]) => { toolResults: { role: 'tool'; tool_call_id: string; content: string }[]; displayMessages: unknown[] }
  /** 流式输出时每收到一段内容时调用（可用来更新 UI 预览） */
  onStreamChunk: (preview: string) => void
  /** 在最后一条消息前插入展示消息（如骰子、系统提示） */
  insertMessagesBeforeLast: (messages: unknown[]) => void
  /** 返回当前故事上下文，供 LangGraph 使用；每轮调用以获取最新 state */
  getStoryContext?: () => StoryContext | null
}

export interface DirectChatCallbacks {
  onStreamChunk: (content: string) => void
}

function getKpApi() {
  return getBridge()
}

export function hasKpAgent(): boolean {
  const api = getKpApi()
  return !!(api?.kpInvoke ?? api?.kpInvokeStream)
}

export async function kpInvokeOnce(
  msgs: unknown[],
  aiConfig: AIProviderConfig,
  onDelta?: (chunk: string) => void,
  storyContext?: StoryContext | null
): Promise<{ content?: string; toolCalls?: ToolCall[] }> {
  const api = getKpApi()
  // Adjustment (api-contract §4): AI config (provider/model/baseUrl/apiKey/
  // temperature/maxTokens) and storyContext are no longer sent — the server
  // runs the LangGraph KP agent with the user's stored AI settings and its
  // own session state.
  const params = {
    messages: msgs as { role: string; content: string }[],
  }
  void aiConfig
  void storyContext

  if (api?.kpInvokeStream && api?.onKpStream) {
    const { streamId } = await api.kpInvokeStream(params)
    return await new Promise((resolve, reject) => {
      let streamed = ''
      const off = api.onKpStream!((payload) => {
        if (!payload || payload.streamId !== streamId) return
        if (payload.type === 'chunk' && payload.chunk) {
          streamed += payload.chunk
          onDelta?.(payload.chunk)
        } else if ((payload as { type?: string }).type === 'trace' && (payload as { traceEvents?: unknown }).traceEvents) {
          // 保留原逻辑（trace 帧接线见任务报告；当前 WS 层按未知帧静默丢弃，
          // 该分支为惰性保留，不产生副作用；shared KpStreamPayload 未定义 trace 帧，
          // 类型层面放宽，运行时不变）
          const traceEvents = (payload as unknown as { traceEvents: { span: string; type: string; data: Record<string, unknown> }[] }).traceEvents
          for (const te of traceEvents) {
            traceBus.emitRaw(te.span, te.type, te.data)
          }
        } else if (payload.type === 'end') {
          off()
          resolve({ content: payload.content ?? streamed, toolCalls: payload.toolCalls })
        } else if (payload.type === 'error') {
          off()
          reject(new Error(payload.error || 'KP stream error'))
        }
      })
    })
  }

  return await api.kpInvoke(params) as Promise<{ content?: string; toolCalls?: ToolCall[] }>
}

const MAX_TOOL_ITERATIONS = 8

export async function runKpAgentLoop(
  chatMessages: unknown[],
  aiConfig: AIProviderConfig,
  callbacks: KpAgentCallbacks
): Promise<string> {
  let fullContent = ''
  let msgs: unknown[] = chatMessages

  for (let loop = 0; loop < MAX_TOOL_ITERATIONS; loop++) {
    traceBus.emit('kp_agent', 'kp_agent_loop_iteration', {
      iteration: loop,
      maxIterations: MAX_TOOL_ITERATIONS,
      hasToolCalls: false,
    })
    const base = fullContent
    let iter = ''
    const storyContext = callbacks.getStoryContext?.() ?? null
    const genStart = Date.now()
    const r = await kpInvokeOnce(msgs, aiConfig, (chunk) => {
      iter += chunk
      const preview = base ? base + '\n\n' + iter : iter
      callbacks.onStreamChunk(preview)
    }, storyContext)

    const endContent = r?.content
    const iterFinal = (endContent !== undefined && endContent !== null ? endContent : iter) || ''
    if (iterFinal.trim()) {
      fullContent = base ? base + '\n\n' + iterFinal : iterFinal
    }
    callbacks.onStreamChunk(fullContent)

    traceBus.emit('kp_agent', 'llm_generate_end', {
      responseLength: iterFinal.length,
      hasToolCalls: !!(r?.toolCalls?.length),
      toolCallCount: r?.toolCalls?.length ?? 0,
      durationMs: Date.now() - genStart,
    })

    if (!r?.toolCalls?.length) break

    const { toolResults, displayMessages } = callbacks.processToolCalls(r.toolCalls)
    callbacks.insertMessagesBeforeLast(displayMessages)
    msgs = [
      ...msgs,
      {
        role: 'assistant' as const,
        content: iterFinal,
        tool_calls: r.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments },
          ...((t as Record<string, unknown>)._thoughtSignature ? { _thoughtSignature: (t as Record<string, unknown>)._thoughtSignature } : {}),
        })),
      },
      ...toolResults,
    ]
  }

  if (!fullContent.trim()) {
    fullContent = '守密人正在思考……请稍候再试，或换一种方式描述你的行动。'
    callbacks.onStreamChunk(fullContent)
  }

  return fullContent
}

export async function runDirectChat(
  chatMessages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  aiConfig: AIProviderConfig,
  callbacks: DirectChatCallbacks
): Promise<string> {
  traceBus.emit('kp_agent', 'direct_chat_used', { reason: 'no_kp_agent_available' })
  let fullContent = ''
  const result = await chat(aiConfig, { messages: chatMessages, stream: true })
  if (isStreamResponse(result)) {
    for await (const chunk of result) {
      fullContent += chunk
      callbacks.onStreamChunk(fullContent)
    }
  } else {
    fullContent = result.content ?? ''
    callbacks.onStreamChunk(fullContent)
  }
  return fullContent
}
