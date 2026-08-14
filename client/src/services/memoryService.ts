/**
 * Long-term memory summarization: merges recent conversation with current summary via LLM.
 * Used on scene change and periodically; run fire-and-forget so the turn is not blocked.
 */
import type { AIProviderConfig } from './ai/types'
import { chat } from './ai'

const SUMMARIZE_SYSTEM = `你是一个 COC 跑团长期记忆整理助手。根据「近期对话」与「当前长期摘要」，输出一段简洁的合并后的长期摘要（中文）。
要求：
- 必须包含：所有已获得的线索名称、所有到过的场景、关键NPC及其态度变化、战斗/伤亡记录、角色当前持有的重要物品。
- 若提供「当前故事上下文」，它是当前局面/状态的权威描述，可用于校正对话中的歧义或遗漏（例如当前场景、SAN 状态、已获得线索等）。
- 用第三人称简述，控制在 500 字以内。
- 只输出合并后的摘要正文，不要加标题或解释。`

export interface SummarizePayload {
  recentMessagesText: string
  currentSummary: string
  /** Optional: current story context (scene/SAN/clues). Kept short and authoritative. */
  storyContextText?: string
  /** Optional: RAG context (story + GraphRAG) for memory grounding. */
  ragContextText?: string
  /** Optional: user graph summary (obtained clues, visited scenes). */
  userGraphSummary?: string
}

/**
 * Call LLM to merge recent messages into the long-term summary.
 * On failure returns the unchanged currentSummary (caller should keep previous).
 */
export async function summarizeLongTerm(
  aiConfig: AIProviderConfig,
  payload: SummarizePayload
): Promise<string> {
  const { recentMessagesText, currentSummary, storyContextText, ragContextText, userGraphSummary } = payload
  const storyCtxBlock = storyContextText && storyContextText.trim()
    ? `【当前故事上下文】\n${storyContextText.trim()}\n\n`
    : ''
  const ragBlock = ragContextText && ragContextText.trim()
    ? `【剧本相关情报（RAG检索）】\n${ragContextText.trim().slice(0, 800)}${ragContextText.length > 800 ? '…' : ''}\n\n`
    : ''
  const userGraphBlock = userGraphSummary && userGraphSummary.trim()
    ? `【调查员行动记录】\n${userGraphSummary.trim()}\n\n`
    : ''
  const userContent =
    currentSummary.trim()
      ? `${storyCtxBlock}${ragBlock}${userGraphBlock}【当前长期摘要】\n${currentSummary}\n\n【近期对话】\n${recentMessagesText}\n\n请将上述合并为一段新的长期摘要。`
      : `${storyCtxBlock}${ragBlock}${userGraphBlock}【近期对话】\n${recentMessagesText}\n\n请将上述整理为一段长期摘要（场景、线索、重要NPC、关键事件）。`
  try {
    const result = await chat(aiConfig, {
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: userContent },
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
