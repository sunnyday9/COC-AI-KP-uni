/**
 * 房间记忆服务（ADR-0002 上下文收口）：自客户端 memoryService/memoryExtractService
 * 原样移植两段轻量 LLM 编排，改走服务端 aiService.chat（配置在服务端，MOCK_AI 短路）。
 * 失败回退与客户端一致：抽取失败 → 截断兜底；摘要失败 → 保持原摘要。
 */
import type { ChatMessage } from './aiService.js'

const EXTRACT_SYSTEM =
  '从守密人回复中提取3-5条关键信息要点，每条≤40字，JSON数组格式。\n' +
  '提取重点：描述了什么场景/NPC、告知了什么信息、发生了什么事件、提供了什么选项。\n' +
  '示例输出：["描述了雾中校门口场景","介绍了保卫处处长李建国","告知12名学生失踪","给出三个行动选项"]'

/** 从 KP 回复抽取 3-5 条记忆要点；失败回退为截断单条。 */
export async function extractMemoryPoints(userId: number, kpResponse: string): Promise<string[]> {
  try {
    const { chat } = await import('./aiService.js')
    const result = await chat(userId, {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: kpResponse.slice(0, 1500) },
      ],
      stream: false,
      maxTokens: 128,
      temperature: 0.1,
    })
    const content = result && typeof result === 'object' && 'content' in result ? (result as { content?: string }).content ?? '' : ''
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

const SUMMARIZE_SYSTEM = `你是一个 COC 跑团长期记忆整理助手。根据「近期对话」与「当前长期摘要」，输出一段简洁的合并后的长期摘要（中文）。
要求：
- 必须包含：所有已获得的线索名称、所有到过的场景、关键NPC及其态度变化、战斗/伤亡记录、角色当前持有的重要物品。
- 若提供「当前故事上下文」，它是当前局面/状态的权威描述，可用于校正对话中的歧义或遗漏（例如当前场景、SAN 状态、已获得线索等）。
- 用第三人称简述，控制在 500 字以内。
- 只输出合并后的摘要正文，不要加标题或解释。`

export interface SummarizePayload {
  recentMessagesText: string
  currentSummary: string
  /** 当前局面/状态简述（场景/线索），权威校正用。 */
  storyContextText?: string
}

/** 合并近期对话进长期摘要；失败返回原摘要（调用方保持前值）。 */
export async function summarizeLongTerm(userId: number, payload: SummarizePayload): Promise<string> {
  const { recentMessagesText, currentSummary, storyContextText } = payload
  const storyCtxBlock = storyContextText && storyContextText.trim() ? `【当前故事上下文】\n${storyContextText.trim()}\n\n` : ''
  const userContent = currentSummary.trim()
    ? `${storyCtxBlock}【当前长期摘要】\n${currentSummary}\n\n【近期对话】\n${recentMessagesText}\n\n请将上述合并为一段新的长期摘要。`
    : `${storyCtxBlock}【近期对话】\n${recentMessagesText}\n\n请将上述整理为一段长期摘要（场景、线索、重要NPC、关键事件）。`
  try {
    const { chat } = await import('./aiService.js')
    const result = await chat(userId, {
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: userContent } satisfies ChatMessage,
      ],
      stream: false,
      maxTokens: 768,
    })
    const content = result && typeof result === 'object' && 'content' in result ? (result as { content?: string }).content : ''
    return (content ?? '').trim() || currentSummary
  } catch {
    return currentSummary
  }
}
