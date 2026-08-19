/**
 * kpTurnService — 服务端图内工具循环（MOCK_AI 确定性链路）。
 * 验证：侦查消息 → skill_check → grant_clue → 「线索已记录」收尾的完整闭环。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { runKpTurn } from '../src/services/kpTurnService.js'
import type { COCCharacterSheet } from '../../shared/types/character.js'

beforeAll(() => {
  process.env.MOCK_AI = '1'
})

const MOCK_SHEET: COCCharacterSheet = {
  occupationId: 'judge',
  occupationName: '法官',
  playerName: '测试员',
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 60, edu: 60, luck: 50 },
  skills: { 'Spot Hidden': 65 },
  derived: { hp: 10, hpMax: 10, mp: 6, mpMax: 6, san: 60, sanMax: 60 },
  dailySanLoss: 0,
  phobias: [],
  manias: [],
  hasMajorWound: false,
  isDying: false,
  weapons: [],
}

describe('kpTurnService (MOCK_AI 服务端图内循环)', () => {
  it('侦查消息 → skill_check → grant_clue → 线索已记录 闭环', async () => {
    const userId = 1
    const messages = [
      { role: 'system' as const, content: '你是守秘人。' },
      { role: 'user' as const, content: '我侦查一下书架。' },
    ]
    const chunks: string[] = []
    const mutators = {
      updateCharacterHP: () => {},
      updateCharacterMP: () => {},
      updateCharacterSAN: () => {},
      updateCharacterLuck: () => {},
      addCharacterDailySanLoss: () => {},
      resetCharacterDailySanLoss: () => {},
      updateCharacterInsanityState: () => {},
      setCharacterMajorWound: () => {},
      setCharacterDying: () => {},
      growCharacterSkill: () => {},
      increaseCthulhuMythos: () => {},
      transitionToScene: () => {},
      addClue: () => {},
      endGame: () => {},
      generateId: () => 'id_' + Math.random(),
    }
    const result = await new Promise<{ content: string; displayMessages: unknown[]; toolCalls: { name: string }[]; worldDeltas: { cluesAdded: { description: string }[] } }>((resolve, reject) => {
      void runKpTurn(
        userId,
        { messages, storyContext: null },
        MOCK_SHEET,
        mutators,
        {
          onChunk: (c) => chunks.push(c),
          onEnd: (r) => resolve({ content: r.content, displayMessages: r.displayMessages, toolCalls: r.toolCalls, worldDeltas: r.worldDeltas }),
          onError: (e) => reject(new Error(e)),
        },
      )
    })

    expect(result.toolCalls.map((t) => t.name)).toEqual(['skill_check', 'grant_clue'])
    expect(result.worldDeltas.cluesAdded.length).toBe(1)
    expect(result.worldDeltas.cluesAdded[0]!.description).toContain('铜钥匙')
    expect(result.content).toContain('线索已记录')
    // displayMessages 应包含骰子检定消息
    expect(result.displayMessages.some((m) => (m as { content?: string }).content?.includes('检定'))).toBe(true)
  }, 30_000)
})
