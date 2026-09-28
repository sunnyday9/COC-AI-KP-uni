import { describe, expect, it, vi } from 'vitest'

const chatMock = vi.hoisted(() => vi.fn())
vi.mock('../aiService.js', () => ({ chat: chatMock }))

import { chat } from '../aiService.js'
import { summarizeLongTerm } from '../roomMemory.js'

describe('roomMemory long-term summary', () => {
  it('gives important tool outcomes a distinct, authoritative place in the summary input', async () => {
    vi.mocked(chat).mockResolvedValue({ content: '保留检定结果的摘要' } as never)

    const summary = await summarizeLongTerm(1, {
      recentMessagesText: '调查员检查了门锁。',
      recentToolResultsText: '侦查检定 d100: 17 / 目标≤65 → 困难成功',
      currentSummary: '调查员进入旧图书馆。',
    })

    expect(summary).toBe('保留检定结果的摘要')
    const request = vi.mocked(chat).mock.calls.at(-1)?.[1]
    expect(request?.messages[1]?.content).toContain('重要工具结果')
    expect(request?.messages[1]?.content).toContain('困难成功')
  })
})
