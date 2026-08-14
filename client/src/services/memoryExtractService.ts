/**
 * Extract structured memory points from KP responses via lightweight LLM call.
 * Falls back to simple truncation on failure.
 */
import type { AIProviderConfig } from './ai/types'
import { chat } from './ai'

const EXTRACT_SYSTEM =
  '从守密人回复中提取3-5条关键信息要点，每条≤40字，JSON数组格式。\n' +
  '提取重点：描述了什么场景/NPC、告知了什么信息、发生了什么事件、提供了什么选项。\n' +
  '示例输出：["描述了雾中校门口场景","介绍了保卫处处长李建国","告知12名学生失踪","给出三个行动选项"]'

export async function extractMemoryPoints(
  aiConfig: AIProviderConfig,
  kpResponse: string,
): Promise<string[]> {
  try {
    const result = await chat(aiConfig, {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: kpResponse.slice(0, 1500) },
      ],
      stream: false,
      maxTokens: 128,
      temperature: 0.1,
    })
    const content = result && typeof result === 'object' && 'content' in result
      ? (result as { content?: string }).content ?? ''
      : ''
    const match = content.match(/\[[\s\S]*\]/)
    if (match) {
      const arr = JSON.parse(match[0]) as unknown[]
      const points = arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      if (points.length > 0) return points.slice(0, 5)
    }
  } catch {
    // fall through to fallback
  }
  return [kpResponse.slice(0, 80) + '…']
}
