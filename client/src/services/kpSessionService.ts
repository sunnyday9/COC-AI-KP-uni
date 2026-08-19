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
  const params: {
    messages: { role: string; content: string }[]
    storyContext?: unknown
  } = {
    messages: msgs as { role: string; content: string }[],
  }
  // Structured story state (scriptId / open clues / scene) — the server uses
  // it for clue gating (scriptContext) and sanity forcing. Optional: absent
  // → server falls back to history extraction.
  if (storyContext) params.storyContext = storyContext

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

/** Phase A2 服务端图内工具循环：一次调用完成「图执行 + 工具执行 + 角色卡更新」。 */
export interface KpTurnCallbacks {
  onStreamChunk: (preview: string) => void
  /** 工具产生的骰子/系统展示消息（服务端 rule-engine 生成）。 */
  onDisplayMessages?: (messages: unknown[]) => void
  /** 服务端更新后的角色卡快照（回合结束时回传）。 */
  onCharacterSheetUpdate?: (sheet: unknown) => void
  /** 服务端工具执行产生的世界增量（线索/场景/结局）。 */
  onWorldDeltas?: (deltas: { cluesAdded?: { description: string; clueId?: string }[]; sceneChanged?: string; ending?: unknown }) => void
}

/**
 * 调用服务端 `kp:turn`：携带角色卡快照，服务端在单次 WS 往返内执行
 * 完整图循环（≤8 轮）并回传 content + displayMessages + 更新后的角色卡。
 * 客户端不再执行任何工具。
 */
export async function runKpTurn(
  msgs: unknown[],
  aiConfig: AIProviderConfig,
  storyContext: StoryContext | null,
  characterSheet: unknown,
  callbacks: KpTurnCallbacks,
): Promise<{ content: string; displayMessages: unknown[]; toolCalls: ToolCall[]; worldDeltas: { cluesAdded?: { description: string; clueId?: string }[]; sceneChanged?: string; ending?: unknown }; characterSheet: unknown }> {
  const api = getKpApi()
  const params: {
    messages: { role: string; content: string }[]
    storyContext?: unknown
    characterSheet?: unknown
  } = {
    messages: msgs as { role: string; content: string }[],
  }
  if (storyContext) params.storyContext = storyContext
  if (characterSheet) params.characterSheet = characterSheet

  let displayMessages: unknown[] = []
  let toolCalls: ToolCall[] = []
  let worldDeltas: { cluesAdded?: { description: string; clueId?: string }[]; sceneChanged?: string; ending?: unknown } = { cluesAdded: [] }
  let updatedSheet: unknown = characterSheet

  if (api?.kpInvokeStream && api?.onKpStream) {
    const { streamId } = await api.kpInvokeStream(params)
    return await new Promise((resolve, reject) => {
      let streamed = ''
      const off = api.onKpStream!((payload) => {
        if (!payload || payload.streamId !== streamId) return
        if (payload.type === 'chunk' && payload.chunk) {
          streamed += payload.chunk
          callbacks.onStreamChunk(streamed)
        } else if (payload.type === 'end') {
          off()
          const content = payload.content ?? streamed
          // 最终 content 若未通过 chunk 推送（MOCK/非流式收尾），补一次推送，
          // 保证 UI 一定能看到完整回复。
          if (content && content !== streamed) {
            callbacks.onStreamChunk(content)
          }
          if (Array.isArray(payload.displayMessages)) {
            displayMessages = payload.displayMessages
            callbacks.onDisplayMessages?.(displayMessages)
          }
          if (Array.isArray(payload.toolCalls)) {
            toolCalls = (payload.toolCalls as ToolCall[])
          }
          if (payload.worldDeltas) {
            worldDeltas = payload.worldDeltas as typeof worldDeltas
            callbacks.onWorldDeltas?.(worldDeltas)
          }
          if (payload.characterSheet) {
            updatedSheet = payload.characterSheet
            callbacks.onCharacterSheetUpdate?.(updatedSheet)
          }
          resolve({ content: content as string, displayMessages, toolCalls, worldDeltas, characterSheet: updatedSheet })
        } else if (payload.type === 'error') {
          off()
          reject(new Error(payload.error || 'KP turn error'))
        }
      })
    })
  }

  // 兜底：无 WS 时回退到单次 invoke（无工具执行——服务端图循环不可用时仅叙事）
  const r = await api.kpInvoke(params)
  const content = r?.content ?? ''
  callbacks.onStreamChunk(content)
  return { content, displayMessages, toolCalls: r?.toolCalls ?? [], worldDeltas, characterSheet: updatedSheet }
}

const MAX_TOOL_ITERATIONS = 8

/** Cap the tool-result payload echoed back into the conversation (long-chain
 * degradation guard): the trace bus already keeps the full result, so the
 * LLM only needs the head of the JSON. */
const MAX_TOOL_RESULT_CHARS = 600
/** Head of a tool result: first-level key/value pairs, for the LLM to see the
 * outcome at a glance without the full JSON (long tool chains echo history). */
const MAX_TOOL_RESULT_SUMMARY_CHARS = 120

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
}

/** Build a compact `{success, skillName, roll, …}` summary head for tool results. */
function summarizeToolResult(content: string): string {
  try {
    const data = JSON.parse(content) as Record<string, unknown>
    if (data === null || typeof data !== 'object') return ''
    const pairs: string[] = []
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      pairs.push(`${k}: ${s.slice(0, 40)}`)
      if (pairs.length >= 6) break
    }
    if (pairs.length === 0) return ''
    let head = `【结果摘要】${pairs.join('；')}`
    if (head.length > MAX_TOOL_RESULT_SUMMARY_CHARS) {
      head = `${head.slice(0, MAX_TOOL_RESULT_SUMMARY_CHARS)}…`
    }
    return head + '\n'
  } catch {
    return ''
  }
}

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
    let r: { content?: string; toolCalls?: ToolCall[] }
    try {
      r = await kpInvokeOnce(msgs, aiConfig, (chunk) => {
        iter += chunk
        const preview = base ? base + '\n\n' + iter : iter
        callbacks.onStreamChunk(preview)
      }, storyContext)
    } catch (err) {
      // A failed iteration must not burn the remaining retries: record and
      // stop, keeping whatever narrative was produced so far.
      traceBus.emit('kp_agent', 'trace_error', {
        source: 'kp_agent_loop',
        message: err instanceof Error ? err.message : String(err),
        iteration: loop,
      })
      break
    }

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
      ...toolResults.map((tr) => ({ ...tr, content: summarizeToolResult(tr.content) + truncateToolResult(tr.content) })),
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
