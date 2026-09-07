/**
 * kpTurnService — 服务端图内工具循环（MOCK_AI 确定性链路）。
 * 验证：侦查消息 → skill_check → grant_clue → 「线索已记录」收尾的完整闭环。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { runKpTurn } from '../src/services/kpTurnService.js'
import { createCharacterMutatorFactory } from '../src/rule-engine/characterMutators.js'
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
    const result = await new Promise<{ content: string; displayMessages: unknown[]; toolCalls: { name: string }[]; worldDeltas: { cluesAdded: { description: string }[] } }>((resolve, reject) => {
      void runKpTurn(
        userId,
        { messages, storyContext: null },
        {
          characters: { default: MOCK_SHEET },
          activeCharacterId: 'default',
          // 真实工厂（评审候选 1）：15 个变更语义的唯一实现走完整闭环
          mutatorFactory: createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'default' ? MOCK_SHEET : null) }),
          handlers: {
            onChunk: (c) => chunks.push(c),
            onEnd: (r) => resolve({ content: r.content, displayMessages: r.displayMessages, toolCalls: r.toolCalls, worldDeltas: r.worldDeltas }),
            onError: (e) => reject(new Error(e)),
          },
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

  it('dossier 查证链（storyLookup 注入）：查证消息 → scene_list → scene_dossier → 叙事收尾', async () => {
    const userId = 1
    const messages = [
      { role: 'system' as const, content: '你是守秘人。' },
      { role: 'user' as const, content: '我查证一下剧本里有哪些地点。' },
    ]
    // storyLookup: 记录被调用的工具；返回 mock 档案查询结果（与 roomService.buildStoryLookup 文本形态一致）
    const lookupCalls: string[] = []
    const storyLookup = async (toolName: string, args: Record<string, unknown>): Promise<{ content: string }> => {
      lookupCalls.push(toolName)
      if (toolName === 'scene_list') {
        return { content: '- 旧图书馆：管理员阿洛伊斯在此\n- 地下室：铁链封锁\n- 档案室：泛黄卷宗' }
      }
      if (toolName === 'scene_dossier') {
        return { content: '场景：旧图书馆\n现场描述：灰尘与霉味。\n在场 NPC：阿洛伊斯（管理员）' }
      }
      return { content: 'error: unknown' }
    }
    const chunks: string[] = []
    const result = await new Promise<{ content: string; toolCalls: { name: string }[] }>((resolve, reject) => {
      void runKpTurn(
        userId,
        { messages, storyContext: null },
        {
          characters: { default: MOCK_SHEET },
          activeCharacterId: 'default',
          mutatorFactory: createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'default' ? MOCK_SHEET : null) }),
          storyLookup,
          handlers: {
            onChunk: (c) => chunks.push(c),
            onEnd: (r) => resolve({ content: r.content, toolCalls: r.toolCalls }),
            onError: (e) => reject(new Error(e)),
          },
        },
      )
    })

    // mock 链：scene_list → scene_dossier → 叙事（图 validate 可能对查证轮补 grant_clue，只验证查证前缀）
    expect(lookupCalls).toEqual(['scene_list', 'scene_dossier'])
    expect(result.toolCalls.map((t) => t.name).slice(0, 2)).toEqual(['scene_list', 'scene_dossier'])
    expect(result.content.length).toBeGreaterThan(0)
  }, 30_000)
})
