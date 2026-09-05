/**
 * openai_chat 端点调用（T3 #39）：与 server/src/services/llm/openaiChat.ts
 * 同参同形（temperature/max_tokens 默认 0.7/2048，tools + tool_choice auto），
 * 但用裸 fetch 直连 `{baseUrl}/chat/completions`——评测 harness 不背 OpenAI SDK。
 */
import type { KpWireMessage } from './request.ts'

export interface EvalEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
}

export interface ChatCallResult extends ModelResponseShape {
  usage: { promptTokens: number; completionTokens: number }
}

interface ModelResponseShape {
  content: string
  toolCalls: { name: string; arguments: string }[]
}

export class EndpointError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
    this.name = 'EndpointError'
  }
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** 单次回合调用（含重试：网络/429/5xx → 1s/3s 退避，共 3 次）。 */
export async function callTurn(ep: EvalEndpoint, messages: KpWireMessage[], tools: unknown[]): Promise<ChatCallResult> {
  const body = {
    model: ep.model,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: ep.temperature,
    max_tokens: ep.maxTokens,
  }
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 3000))
    try {
      return await callOnce(ep, body)
    } catch (err) {
      lastErr = err
      if (err instanceof EndpointError && err.status !== undefined && err.status < 500 && err.status !== 429) throw err
    }
  }
  throw lastErr
}

async function callOnce(ep: EvalEndpoint, body: unknown): Promise<ChatCallResult> {
  const res = await fetch(chatUrl(ep.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ep.timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new EndpointError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const msg = data.choices?.[0]?.message ?? {}
  return {
    content: msg.content ?? '',
    toolCalls: (msg.tool_calls ?? []).map((tc, i) => ({
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments && tc.function.arguments.trim() ? tc.function.arguments : '{}',
      id: tc.id ?? `tc_${i}`,
    })),
    usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
  }
}
