import {
  createKPGraph,
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
  /** Optional structured story state (scriptId / clues / scene); null/absent → current behavior. */
  storyContext?: Record<string, unknown> | null
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
 * Exported for kpTurnService (服务端图内工具循环, Phase A2) to reuse.
 */
export function buildInvokeLLM(
  userId: number,
  ai: ReturnType<typeof getAiConfig>,
  opts: { stream?: boolean; onChunk?: (chunk: string) => void },
): InvokeLLM {
  return async (msgs: KpMessage[]) => {
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

/* ═══════════════════ Graph instance cache (perf) ═══════════════════ */

/**
 * createKPGraph rebuilds the whole StateGraph per invoke. The graph is
 * stateless (all state comes from the invoke payload), so a short-TTL cache
 * avoids the rebuild cost inside a tool chain (up to 8 invokes per turn).
 *
 * Streaming invokes are NEVER cached: the generate node's closure captures
 * the per-request onChunk callback, and reusing a stale closure would stream
 * chunks into a dead connection.
 */
const GRAPH_CACHE_TTL_MS = 10_000

const graphCache = new Map<string, { graph: ReturnType<typeof createKPGraph>; expiresAt: number }>()

/** Exported for kpTurnService (Phase A2). */
export function getSharedGraph(invokeLLM: InvokeLLM, userId?: number, stream?: boolean): ReturnType<typeof createKPGraph> {
  if (stream) return createKPGraph(invokeLLM, userId)
  // The key includes the invokeLLM closure: the closure captures the resolved
  // AI config (settings change → new closure → new cache entry), so a config
  // update can never be served a stale graph.
  const key = `${String(userId ?? 'anon')}:${String(invokeLLM)}`
  const now = Date.now()
  const hit = graphCache.get(key)
  if (hit && hit.expiresAt > now) {
    return hit.graph
  }
  const graph = createKPGraph(invokeLLM, userId)
  graphCache.set(key, { graph, expiresAt: now + GRAPH_CACHE_TTL_MS })
  if (graphCache.size > 50) {
    for (const [k, v] of graphCache) {
      if (v.expiresAt <= now) graphCache.delete(k)
    }
  }
  return graph
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
 * Validate and normalize the wire-format messages.
 * Exported for kpTurnService (Phase A2).
 *  - Non-array input is rejected with a 400-style BadRequestError (previously
 *    it silently returned `[]` → empty 200/end frame, see test-agent AW-R-01).
 *  - Every message must have string role/content (unchanged).
 *  - `assistant` messages: `tool_calls` must be an array whose entries have
 *    string `id` / `function.name` / `function.arguments`; structurally
 *    invalid entries → 400. Unparseable `arguments` JSON is downgraded to
 *    `'{}'` (mirrors the client orchestrator's per-tool error handling) so a
 *    malformed argument payload never crashes the graph or the upstream LLM
 *    call (AW-R-09).
 *  - `tool` messages: `tool_call_id` must be a string.
 */
export function normalizeMessages(messages: unknown): KpMessage[] {
  if (!Array.isArray(messages)) {
    throw new BadRequestError('invalid kp:invoke messages: messages must be an array')
  }
  for (const m of messages) {
    if (
      typeof m !== 'object' ||
      m === null ||
      typeof (m as { role?: unknown }).role !== 'string' ||
      typeof (m as { content?: unknown }).content !== 'string'
    ) {
      throw new BadRequestError('invalid kp:invoke messages: each message must have a string role and content')
    }
    const role = (m as { role: string }).role
    if (role === 'assistant') {
      const toolCalls = (m as { tool_calls?: unknown }).tool_calls
      if (toolCalls !== undefined) {
        if (!Array.isArray(toolCalls)) {
          throw new BadRequestError('invalid kp:invoke messages: assistant tool_calls must be an array')
        }
        for (const tc of toolCalls) {
          if (
            typeof tc !== 'object' ||
            tc === null ||
            typeof (tc as { id?: unknown }).id !== 'string' ||
            typeof (tc as { function?: unknown }).function !== 'object' ||
            (tc as { function?: unknown }).function === null ||
            typeof ((tc as { function: { name?: unknown } }).function).name !== 'string' ||
            typeof ((tc as { function: { arguments?: unknown } }).function).arguments !== 'string'
          ) {
            throw new BadRequestError('invalid kp:invoke messages: assistant tool_calls must have string id and function.name/arguments')
          }
        }
      }
    } else if (role === 'tool') {
      if (typeof (m as { tool_call_id?: unknown }).tool_call_id !== 'string') {
        throw new BadRequestError('invalid kp:invoke messages: tool message requires a string tool_call_id')
      }
    }
  }
  return messages.map((m) => {
    if ((m as { role: string }).role === 'assistant') {
      const toolCalls = (m as { tool_calls?: { function: { name?: unknown; arguments: string } }[] }).tool_calls
      if (Array.isArray(toolCalls)) {
        let changed = false
        const normalized = toolCalls.map((tc) => {
          try {
            JSON.parse(tc.function.arguments)
            return tc
          } catch {
            changed = true
            logger.warn('kp:invoke tool_calls arguments not valid JSON, downgraded to {}', {
              toolName: tc.function.name,
            })
            return { ...tc, function: { ...tc.function, arguments: '{}' } }
          }
        })
        return changed ? { ...m, tool_calls: normalized } : m
      }
    }
    return m
  }) as KpMessage[]
}

/** REST path (api-contract §4): single non-streamed graph run. */
export async function invokeKp(userId: number, body: KpInvokeBody): Promise<KpInvokeResult> {
  const messages = normalizeMessages(body?.messages)
  if (messages.length === 0) {
    return { content: '' }
  }

  const ai = getAiConfig(userId)
  const invokeLLM = buildInvokeLLM(userId, ai, {})
  let result: Awaited<ReturnType<typeof invokeKPAgent>>
  try {
    result = await withTimeout(invokeKPAgent(messages, invokeLLM, body?.storyContext ?? null, userId, getSharedGraph(invokeLLM, userId, false)), GRAPH_TIMEOUT_MS, 'KP graph invoke')
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

  const ai = getAiConfig(userId)
  const invokeLLM = buildInvokeLLM(userId, ai, { stream: true, onChunk: handlers.onChunk })
  try {
    const result = await withTimeout(invokeKPAgent(messages, invokeLLM, body?.storyContext ?? null, userId, getSharedGraph(invokeLLM, userId, true)), GRAPH_TIMEOUT_MS, 'KP graph stream')
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
