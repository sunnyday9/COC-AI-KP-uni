/**
 * KP 会话桥接薄壳（Phase A2 后）：客户端不再执行任何工具循环。
 * runKpTurn 经 Platform Bridge 调用服务端 kp:turn（图内工具循环；
 * 截断/摘要策略的唯一实现在 server/src/services/kpTurnService.ts）；
 * runDirectChat 是无 KP agent 时的直连对话 fallback。
 */
import { chat, isStreamResponse } from './ai'
import type { AIProviderConfig } from './ai'
import type { StoryContext } from '../types/storyContext'
import { traceBus } from './tracing'
import { getBridge } from '../platform'

export type ToolCall = { id: string; name: string; arguments: string }

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
