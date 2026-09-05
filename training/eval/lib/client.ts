/**
 * openai_chat 端点调用（T3 #39）：与 server/src/services/llm/openaiChat.ts
 * 同参同形（同一个 openai SDK、temperature/max_tokens 默认 0.7/2048、tools +
 * tool_choice auto）——评测请求形态与线上一比一。SSRF 卫生：baseUrl 先经
 * normalizeEndpointBaseUrl 校验归一才进 SDK。
 */
import OpenAI from 'openai'
import type { KpWireMessage } from './request.ts'

export interface EvalEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
}

export interface ChatCallResult {
  content: string
  toolCalls: { name: string; arguments: string }[]
  usage: { promptTokens: number; completionTokens: number }
}

export class EndpointError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
    this.name = 'EndpointError'
  }
}

/**
 * 端点 URL 校验与归一化（SSRF 卫生）：CLI 参数/环境变量里的 baseUrl 必须先过
 * 这里——协议白名单 http/https、hostname 非空、剔除内嵌凭据，SDK 只使用归一化
 * 产物。本地端点（localhost/vLLM）合法可用，与 ADR-0003 同尺度（不豁免也不禁止）。
 */
export function normalizeEndpointBaseUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(String(raw).trim())
  } catch {
    throw new Error(`无效的端点 URL: ${JSON.stringify(raw)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`端点协议只允许 http/https，实际: ${u.protocol}`)
  }
  if (!u.hostname) {
    throw new Error('端点 URL 缺少 hostname')
  }
  u.username = ''
  u.password = ''
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  return u.origin + path
}

/** 单次回合调用（含重试：网络/429/5xx → 1s/3s 退避，共 3 次）。 */
export async function callTurn(ep: EvalEndpoint, messages: KpWireMessage[], tools: unknown[]): Promise<ChatCallResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 3000))
    try {
      return await callOnce(ep, messages, tools)
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number }).status
      if (typeof status === 'number' && status < 500 && status !== 429) throw err
    }
  }
  throw lastErr
}

async function callOnce(ep: EvalEndpoint, messages: KpWireMessage[], tools: unknown[]): Promise<ChatCallResult> {
  // 与 server openaiChat 适配器同参：baseURL/apiKey/model/messages/tools/tool_choice/temperature/max_tokens
  const client = new OpenAI({ baseURL: ep.baseUrl, apiKey: ep.apiKey || 'not-needed', timeout: ep.timeoutMs, maxRetries: 0 })
  try {
    const res = await client.chat.completions.create({
      model: ep.model,
      messages: messages as unknown as Parameters<typeof client.chat.completions.create>[0]['messages'],
      tools: tools as unknown as Parameters<typeof client.chat.completions.create>[0]['tools'],
      tool_choice: 'auto',
      temperature: ep.temperature,
      max_tokens: ep.maxTokens,
    })
    const msg = res.choices?.[0]?.message ?? {}
    return {
      content: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((tc, i) => ({
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments && tc.function.arguments.trim() ? tc.function.arguments : '{}',
        id: tc.id ?? `tc_${i}`,
      })),
      usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
    }
  } catch (err) {
    const status = (err as { status?: number }).status
    const message = err instanceof Error ? err.message : String(err)
    throw new EndpointError(`端点调用失败: ${message}`, typeof status === 'number' ? status : undefined)
  }
}
