import {
  invokeKPAgent,
  type InvokeLLM,
  type KpMessage,
  type KpToolCall,
  type KpTraceEvent,
} from '../agent/kpGraph.js'
import { COC_KP_TOOLS } from '../../../shared/tools/cocTools.js'
import { chatForAgent } from './aiService.js'
import { getAiConfig } from './settingsService.js'
import { BadRequestError, UpstreamError, errorMessage } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

/**
 * KP Agent service (api-contract §4) — migrated from
 * `original/ai-trpg-web/electron/ipc/kpAgentHandlers.cjs`.
 *
 * Single-shot invoke (REST) and streamed invoke (WS) both run the LangGraph
 * state machine once and return `{ content?, toolCalls? }`; the multi-turn
 * tool-execution loop stays client-side (ledger Ruling, task-3-brief).
 *
 * Deviations from the original (per task-3-brief decision 8):
 *  - The original's directFallback (raw chat when the graph fails or returns
 *    empty) is NOT migrated: graph failure/timeout → UpstreamError (REST 502)
 *    or WS `error` message; empty results are returned as-is.
 *  - AI config comes solely from the user's settings (no IPC params).
 *  - 120s graph timeout guards against hung LLM calls.
 */

/** Graph execution hard timeout (brief: 图超时 120s 兜底). */
export const GRAPH_TIMEOUT_MS = 120_000

export interface KpInvokeBody {
  messages: KpMessage[]
}

export interface KpInvokeResult {
  content?: string
  toolCalls?: KpToolCall[]
}

export interface KpStreamHandlers {
  /** WS: push `{ type: 'chunk', streamId, chunk }`. */
  onChunk: (chunk: string) => void
  /** WS: push `{ type: 'trace', streamId, traceEvents }` (mirrors original). */
  onTrace: (traceEvents: KpTraceEvent[]) => void
  /** WS: push `{ type: 'end', streamId, content, toolCalls }`. */
  onEnd: (result: KpInvokeResult) => void
  /** WS: push `{ type: 'error', streamId, error }`. */
  onError: (error: string) => void
}

/* ═══════════════════ Message classification (from kpAgentHandlers.cjs) ═══════════════════ */

function isIntentClassifierCall(msgs: KpMessage[]): boolean {
  return (
    Array.isArray(msgs) &&
    msgs.length > 0 &&
    msgs[0]?.role === 'system' &&
    typeof msgs[0]?.content === 'string' &&
    msgs[0].content.includes('只回复一个英文意图关键词')
  )
}

function isForceToolCall(msgs: KpMessage[]): boolean {
  return (
    Array.isArray(msgs) &&
    msgs.length > 0 &&
    msgs[msgs.length - 1]?.role === 'user' &&
    typeof msgs[msgs.length - 1]?.content === 'string' &&
    msgs[msgs.length - 1].content.includes('请立即调用以下工具')
  )
}

/* ═══════════════════ invokeLLM builder (buildInvokeLLM / buildStreamInvokeLLM) ═══════════════════ */

/**
 * Build the graph's LLM function. Mirror of the original
 * buildInvokeLLM/buildStreamInvokeLLM with IPC params removed:
 *  - AI config comes from the user's settings (fresh read per call, like the
 *    original readSettings()).
 *  - The intent-classifier call gets maxTokens 32 and no tools; force-tool
 *    calls and the classifier are never streamed.
 *  - All outbound LLM requests pass through aiService (assertSafeOutboundUrl).
 */
function buildInvokeLLM(
  userId: number,
  opts: { stream?: boolean; onChunk?: (chunk: string) => void },
): InvokeLLM {
  return async (msgs: KpMessage[]) => {
    const ai = getAiConfig(userId)

    const isClassifier = isIntentClassifierCall(msgs)
    const isForceTool = isForceToolCall(msgs)
    const canStream = !!opts.stream && !isClassifier && !isForceTool

    const result = await chatForAgent(userId, {
      messages: msgs,
      temperature: ai.temperature,
      maxTokens: isClassifier ? 32 : ai.maxTokens,
      stream: canStream,
      tools: isClassifier ? undefined : COC_KP_TOOLS,
      onChunk: canStream ? opts.onChunk : undefined,
    })
    return result?.toolCalls
      ? { content: result.content ?? '', toolCalls: result.toolCalls }
      : (result?.content ?? '')
  }
}

/* ═══════════════════ Timeout guard ═══════════════════ */

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ═══════════════════ Entry points ═══════════════════ */

/**
 * Validate the wire-format messages. Mirrors the original's
 * `!Array.isArray(messages) || messages.length === 0` → empty result handling;
 * malformed entries (non-string role/content) are rejected with a 400-style
 * BadRequestError instead of failing inside the graph.
 */
function normalizeMessages(messages: unknown): KpMessage[] {
  if (!Array.isArray(messages)) return []
  for (const m of messages) {
    if (
      typeof m !== 'object' ||
      m === null ||
      typeof (m as { role?: unknown }).role !== 'string' ||
      typeof (m as { content?: unknown }).content !== 'string'
    ) {
      throw new BadRequestError('invalid kp:invoke messages: each message must have a string role and content')
    }
  }
  return messages as KpMessage[]
}

/** REST path (api-contract §4): single non-streamed graph run. */
export async function invokeKp(userId: number, body: KpInvokeBody): Promise<KpInvokeResult> {
  const messages = normalizeMessages(body?.messages)
  if (messages.length === 0) {
    return { content: '' }
  }

  const invokeLLM = buildInvokeLLM(userId, {})
  let result: Awaited<ReturnType<typeof invokeKPAgent>>
  try {
    result = await withTimeout(invokeKPAgent(messages, invokeLLM), GRAPH_TIMEOUT_MS, 'KP graph invoke')
  } catch (err) {
    logger.warn('KP graph invoke failed', { userId, error: errorMessage(err) })
    throw new UpstreamError(errorMessage(err))
  }

  return {
    content: result.content || '',
    toolCalls: result.toolCalls,
  }
}

/** WS path (api-contract §4): single graph run with streaming callbacks. */
export async function invokeKpStream(
  userId: number,
  body: KpInvokeBody,
  handlers: KpStreamHandlers,
): Promise<void> {
  const messages = normalizeMessages(body?.messages)
  if (messages.length === 0) {
    handlers.onEnd({ content: '' })
    return
  }

  const invokeLLM = buildInvokeLLM(userId, { stream: true, onChunk: handlers.onChunk })
  try {
    const result = await withTimeout(invokeKPAgent(messages, invokeLLM), GRAPH_TIMEOUT_MS, 'KP graph stream')
    if (result._traceEvents && result._traceEvents.length > 0) {
      handlers.onTrace(result._traceEvents)
    }
    handlers.onEnd({
      content: result.content || '',
      toolCalls: result.toolCalls,
    })
  } catch (err) {
    logger.warn('KP graph stream failed', { userId, error: errorMessage(err) })
    handlers.onError(errorMessage(err))
  }
}
