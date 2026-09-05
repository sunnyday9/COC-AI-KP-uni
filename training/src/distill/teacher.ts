/**
 * 教师端点接入（T4）：DeepSeek V4 Flash（用户 command code 端点，票 #40 开工对齐）。
 *
 * 凭据只从环境变量读取（KP_DISTILL_BASE_URL / KP_DISTILL_API_KEY / KP_DISTILL_MODEL），
 * 源码/示例/测试不落任何端点字面量或密钥。请求走 openai SDK（与 #39 eval client 同一
 * 路径——Mimosa 对 argv/env→裸 fetch 判 SSRF high，SDK 化是既定解法），baseUrl 先过
 * eval client 的 normalizeEndpointBaseUrl 校验归一。
 */
import OpenAI from 'openai'
import { normalizeEndpointBaseUrl, type EvalEndpoint } from '../../eval/lib/client.js'

/** 教师端点（环境变量装配；缺 KP_DISTILL_BASE_URL/API_KEY 即报错并给出设置说明）。 */
export function teacherEndpointFromEnv(): EvalEndpoint {
  const baseUrl = process.env.KP_DISTILL_BASE_URL
  const apiKey = process.env.KP_DISTILL_API_KEY
  const model = process.env.KP_DISTILL_MODEL ?? 'deepseek/deepseek-v4-flash'
  if (!baseUrl || !apiKey) {
    throw new Error(
      '缺少教师端点配置：请设置 KP_DISTILL_BASE_URL 与 KP_DISTILL_API_KEY 环境变量' +
        `（可选 KP_DISTILL_MODEL，默认 ${model}）。凭据只走环境变量，不写入任何文件。`,
    )
  }
  return {
    baseUrl: normalizeEndpointBaseUrl(baseUrl),
    apiKey,
    model,
    temperature: Number(process.env.KP_DISTILL_TEMPERATURE ?? '0.7'),
    maxTokens: Number(process.env.KP_DISTILL_MAX_TOKENS ?? '2048'),
    timeoutMs: Number(process.env.KP_DISTILL_TIMEOUT_MS ?? '120000'),
  }
}

/** 无工具的 JSON 生成调用（Phase A 玩家批次合成）：输出容忍 ```json 围栏。 */
export async function callTeacherJson(
  ep: EvalEndpoint,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ json: Record<string, unknown>; usage: { promptTokens: number; completionTokens: number } }> {
  const client = new OpenAI({ baseURL: ep.baseUrl, apiKey: ep.apiKey || 'not-needed', timeout: ep.timeoutMs, maxRetries: 0 })
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 3000))
    try {
      const res = await client.chat.completions.create({
        model: ep.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: ep.temperature,
        max_tokens: ep.maxTokens,
      })
      const content = res.choices?.[0]?.message?.content ?? ''
      return {
        json: parseLooseJson(content),
        usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
      }
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number }).status
      if (typeof status === 'number' && status < 500 && status !== 429) break
    }
  }
  throw lastErr
}

/** 宽松 JSON 提取：直接 parse，失败则取首个 {…} 平衡块（教师偶发围栏/前后缀）。 */
export function parseLooseJson(content: string): Record<string, unknown> {
  const text = String(content ?? '').trim()
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* 落到平衡块提取 */
  }
  const start = text.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1)) as unknown
            if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
          } catch {
            break
          }
        }
      }
    }
  }
  return {}
}
