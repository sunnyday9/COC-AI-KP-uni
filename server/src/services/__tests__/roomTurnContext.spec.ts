/**
 * 房间回合上下文收口直测（ADR-0002 / T2）：提示词组装、RAG/记忆注入、opening 回合。
 * 桩 kpTurnService.runKpTurn（捕获 chatMessages，模拟 onEnd）；桩 roomMemory（记忆/摘要确定性）。
 * node:sqlite 临时库（test/setup.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 桩 runKpTurn：记录收到的 messages/storyContext，回显内容。 */
vi.mock('../kpTurnService.js', () => ({
  runKpTurn: vi.fn(async (
    _userId: number,
    body: { messages: { role: string; content: string }[] },
    turn: { activeCharacterId: string | null; handlers: { onChunk: (c: string) => void; onEnd: (r: unknown) => void } },
  ) => {
    turn.handlers.onChunk('（测试）')
    turn.handlers.onEnd({
      content: `KP 回应: ${turn.activeCharacterId ?? 'none'}`,
      displayMessages: [],
      toolCalls: [],
      worldDeltas: { cluesAdded: [] },
      characterSheet: null,
    })
  }),
}))

/** 桩 roomMemory：记忆抽取与长期摘要确定性。 */
vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => ['描述了雾中校门口场景', '介绍了李建国']),
  summarizeLongTerm: vi.fn(async (_userId: number, payload: { currentSummary: string }) => `${payload.currentSummary}+摘要v2`),
}))

/** 桩 ragService：RAG 检索与剧本名确定性（避免真拉 vectorStore/transformers）。 */
vi.mock('../ragService.js', () => ({
  context: vi.fn(async () => ({ context: 'RAG 检索上下文（桩）' })),
  listStories: vi.fn(() => [{ storyId: 'story_x', name: '雾中镇', chunkCount: 1, indexedAt: 0 }]),
}))

import { runKpTurn } from '../kpTurnService.js'
import { RoomService, createSoloRoom, joinRoom, _clearRoomRegistryForTests } from '../roomService.js'
import { buildRoomTurnMessages, buildRoomOpeningMessages, BASE_INSTRUCTIONS } from '../kpPromptService.js'
import { getDb } from '../../db/index.js'
import type { COCCharacterSheet } from '../../../../shared/types/character.js'
import type { Message } from '../../../../shared/types/game.js'

const runKpTurnMock = vi.mocked(runKpTurn)

let userIdSeq = 9620
function seedUser(username: string): number {
  const id = ++userIdSeq
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, username, Date.now())
  return id
}

const sheet = {
  playerName: '艾丽丝',
  occupationName: '侦探',
  attributes: { str: 50, con: 60, siz: 55, dex: 70, app: 50, int: 75, pow: 60, edu: 80, luck: 55 },
  skills: { '侦察': 65 },
  derived: { hp: 10, hpMax: 12, mp: 8, mpMax: 12, san: 55, sanMax: 60, damageBonus: '0', moveRate: 8 },
} as unknown as COCCharacterSheet

beforeEach(() => {
  _clearRoomRegistryForTests()
  runKpTurnMock.mockClear()
})

afterEach(() => {
  _clearRoomRegistryForTests()
})

describe('kpPromptService 房间组装器（纯函数）', () => {
  it('turn：system 含基础指令/记忆/长期摘要/RAG/角色卡；本批行动以合并 user 收尾', () => {
    const history: Message[] = [{ id: 'k1', timestamp: Date.now(), role: 'kp', content: '上一次的叙述' } as Message]
    const input = {
      storyName: '雾中镇',
      scene: '校门口',
      clues: [{ id: 'c1', description: '泥泞脚印' }],
      messages: history,
      kpMemory: ['描述了雾中校门口场景'],
      longTermSummary: '调查员抵达雾中镇',
      characters: [sheet],
    }
    const msgs = buildRoomTurnMessages(input, 'RAG 检索片段……', '【艾丽丝】我检查校门')
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[0]!.content).toContain(BASE_INSTRUCTIONS.slice(0, 20))
    expect(msgs[0]!.content).toContain('## 记忆：你（守密人）在本局已说过的内容')
    expect(msgs[0]!.content).toContain('## 长期记忆（本局至今）')
    expect(msgs[0]!.content).toContain('## 故事情报')
    expect(msgs[0]!.content).toContain('## 故事: 雾中镇')
    expect(msgs[0]!.content).toContain('## 调查员: 艾丽丝 (侦探)')
    expect(msgs.at(-1)).toEqual({ role: 'user', content: '【艾丽丝】我检查校门' })
    expect(msgs.some((m) => m.content === '上一次的叙述' && m.role === 'assistant')).toBe(true)
  })

  it('opening：system 含开场指令，无近窗对话，user 为开场白请求', () => {
    const msgs = buildRoomOpeningMessages(
      { storyName: '雾中镇', scene: null, clues: [], messages: [], kpMemory: [], longTermSummary: '', characters: [sheet] },
      'RAG 片段',
    )
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[0]!.content).toContain('向调查员做开场白')
    expect(msgs[1]).toEqual({ role: 'user', content: '请开始游戏，向调查员做开场白。' })
  })
})

describe('RoomService 回合上下文收口', () => {
  it('flushTurn：记忆/角色组注入 system，本批 user 合并收尾；回合后 kpMemory 更新进快照', async () => {
    const userId = seedUser('ctx_turn')
    const created = createSoloRoom(userId, { storyId: 'story_x', name: '艾丽丝', sheet })
    if (!created.ok) throw new Error('unreachable')
    const room = joinRoom(created.roomId, userId, 'ctx_turn')!
    await vi.waitFor(() => expect(runKpTurnMock).toHaveBeenCalledTimes(1)) // opening 先行
    runKpTurnMock.mockClear()

    room.submitPlayerChat(userId, '我检查校门')
    await vi.waitFor(() => expect(runKpTurnMock).toHaveBeenCalledTimes(1))

    const call = runKpTurnMock.mock.calls[0]!
    const messages = call[1].messages as { role: string; content: string }[]
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('## 调查员: 艾丽丝 (侦探)')
    expect(messages[0]!.content).toContain('RAG 检索上下文（桩）')
    expect(messages.at(-1)!.content).toBe('【ctx_turn】我检查校门')
    expect(call[2].activeCharacterId).toBe(created.characterId)

    // opening + 本回合各落一次抽取要点（fire-and-forget，上限于 MAX_MEMORY_ENTRIES）
    await vi.waitFor(() => expect(room.snapshot().kpMemory?.slice(-2)).toEqual(['描述了雾中校门口场景', '介绍了李建国']))
    expect(room.snapshot().kpMemory).toHaveLength(4)
  })

  it('场景切换触发长期摘要刷新（fire-and-forget）', async () => {
    const userId = seedUser('ctx_scene')
    const room = new RoomService({ roomId: `ctxs_${Date.now()}`, ownerId: userId, ownerName: 'ctx_scene', turnWindowMs: 0 })
    room.setScene('地下室')
    await vi.waitFor(() => expect(room.snapshot().longTermSummary).toBe('+摘要v2'))
  })
})

describe('opening 回合（ADR-0002）', () => {
  it('solo 房 joinRoom 触发 opening：playing + 无消息 → 一次 KP 回合；重复触发不再跑', async () => {
    const userId = seedUser('ctx_open')
    const created = createSoloRoom(userId, { storyId: 'story_o', name: '欧文', sheet })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const room = joinRoom(created.roomId, userId, 'ctx_open')!
    expect(room).not.toBeNull()
    await vi.waitFor(() => expect(runKpTurnMock).toHaveBeenCalledTimes(1))

    const messages = runKpTurnMock.mock.calls[0]![1].messages as { role: string; content: string }[]
    expect(messages[0]!.content).toContain('向调查员做开场白')
    expect(messages[0]!.content).toContain('RAG 检索上下文（桩）')
    await vi.waitFor(() => expect(room.getMessages().some((m) => m.role === 'kp')).toBe(true))

    room.beginOpeningIfPending()
    await new Promise((r) => setTimeout(r, 20))
    expect(runKpTurnMock).toHaveBeenCalledTimes(1) // 不重入
  })

  it('opening 失败不阻塞：回合拒绝后玩家消息照常触发回合', async () => {
    const userId = seedUser('ctx_openfail')
    const created = createSoloRoom(userId, { storyId: 'story_f', name: '菲尔', sheet })
    if (!created.ok) throw new Error('unreachable')
    runKpTurnMock.mockImplementationOnce(async () => {
      throw new Error('KP agent 不可用')
    })
    const room = joinRoom(created.roomId, userId, 'ctx_openfail')!
    await vi.waitFor(() => expect(runKpTurnMock).toHaveBeenCalledTimes(1))
    expect(room.getMessages()).toHaveLength(0) // opening 失败无消息

    room.submitPlayerChat(userId, '我环顾四周')
    await vi.waitFor(() => expect(runKpTurnMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(room.getMessages().some((m) => m.role === 'kp')).toBe(true))
  })

  it('非 playing / 已有消息的房间不触发 opening', async () => {
    const userId = seedUser('ctx_noopen')
    const room = new RoomService({ roomId: `ctxn_${Date.now()}`, ownerId: userId, ownerName: 'ctx_noopen', turnWindowMs: 0 })
    room.beginOpeningIfPending()
    await new Promise((r) => setTimeout(r, 20))
    expect(runKpTurnMock).not.toHaveBeenCalled()
  })
})
