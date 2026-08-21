/**
 * RoomService 回合窗口合并测试（D4/D5）— turnBuffer + flushTurn + 多角色分派。
 *
 * 用真实 RoomService 实例（内存注册表），turnWindowMs 注入小值/0 控制窗口行为；
 * kpTurnService 的图执行用 vi.mock 桩（不触真实 LLM）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../../db/index.js'
import { _clearRoomRegistryForTests, RoomService } from '../roomService.js'
import type { COCCharacterSheet } from '../../../../shared/types/character.js'
import type { Message } from '../../../../shared/types/game.js'

/** 最小 COC 角色卡（E2E 夹具形状）。 */
function makeSheet(id: string, hp = 10): COCCharacterSheet {
  return {
    id,
    playerName: `角色${id}`,
    occupationId: 'occ_test',
    occupationName: '测试职业',
    occupationSkillKeys: [],
    personalInterestKeys: [],
    derived: { hp, hpMax: 12, mp: 6, mpMax: 6, san: 60, sanMax: 99 },
    attributes: { luck: 50 },
    skills: {},
    insanityState: 'normal',
  } as unknown as COCCharacterSheet
}

/** 桩 kpTurnService.runKpTurn：记录收到的 messages/characters/activeCharacterId，按需回显。 */
vi.mock('../kpTurnService.js', () => ({
  runKpTurn: vi.fn(async (
    _userId: number,
    body: { messages: unknown },
    _characters: unknown,
    activeCharacterId: string | null,
    _mutators: unknown,
    handlers: { onChunk: (c: string) => void; onEnd: (r: unknown) => void },
    _factory?: unknown,
  ) => {
    const lastUser = [...(body.messages as { role: string; content: string }[])].reverse().find((m) => m.role === 'user')
    handlers.onChunk('（测试）')
    handlers.onEnd({
      content: `KP 回应（行动者 ${activeCharacterId ?? 'none'}）: ${lastUser?.content ?? ''}`,
      displayMessages: [],
      toolCalls: [],
      worldDeltas: { cluesAdded: [] },
      characterSheet: null,
    })
  }),
}))

import { runKpTurn } from '../kpTurnService.js'
const runKpTurnMock = vi.mocked(runKpTurn)

describe('RoomService 回合窗口合并（D4）', () => {
  let room: RoomService

  beforeEach(() => {
    _clearRoomRegistryForTests()
    room = new RoomService({
      roomId: 'room_test',
      ownerId: 1,
      ownerName: 'alice',
      turnWindowMs: 200,
    })
    runKpTurnMock.mockClear()
  })

  afterEach(() => {
    room.dispose()
    _clearRoomRegistryForTests()
  })

  it('窗口内多条玩家消息合并为一次 KP 回合（【玩家】标记）', async () => {
    room.bindCharacter(1, 'char_a', makeSheet('char_a'))
    room.bindCharacter(2, 'char_b', makeSheet('char_b'))

    room.bufferPlayerChat('alice', '我搜索书架。', 'char_a', 1)
    room.bufferPlayerChat('bob', '我撬开箱子。', 'char_b', 2)
    expect(runKpTurnMock).not.toHaveBeenCalled() // 窗口未超时

    await new Promise((r) => setTimeout(r, 350)) // 等窗口超时 flush
    expect(runKpTurnMock).toHaveBeenCalledTimes(1)

    const call = runKpTurnMock.mock.calls[0]!
    const userMsg = [...(call[1] as { messages: { role: string; content: string }[] }).messages].reverse().find((m) => m.role === 'user')
    expect(userMsg?.content).toContain('【alice】我搜索书架。')
    expect(userMsg?.content).toContain('【bob】我撬开箱子。')
    // 缺省行动者 = 最后一位（D4）
    expect(call[3]).toBe('char_b')
    // KP 回复进消息流
    expect(room.getMessages().some((m) => m.role === 'kp' && m.content.includes('KP 回应'))).toBe(true)
  })

  it('窗口超时立即处理；无多人时单条消息等价即时', async () => {
    room.bufferPlayerChat('alice', '我看看门。', null, 1)
    await new Promise((r) => setTimeout(r, 350))
    expect(runKpTurnMock).toHaveBeenCalledTimes(1)
    const userMsg = [...(runKpTurnMock.mock.calls[0]![1] as { messages: { role: string; content: string }[] }).messages].reverse().find((m) => m.role === 'user')
    expect(userMsg?.content).toBe('【alice】我看看门。')
  })

  it('turnWindowMs=0 → 严格排队：每条消息立即触发（无合并）', async () => {
    const strict = new RoomService({ roomId: 'room_strict', ownerId: 1, ownerName: 'alice', turnWindowMs: 0 })
    try {
      strict.bufferPlayerChat('alice', '第一条', null, 1)
      await new Promise((r) => setTimeout(r, 50))
      strict.bufferPlayerChat('bob', '第二条', null, 2)
      await new Promise((r) => setTimeout(r, 50))
      expect(runKpTurnMock).toHaveBeenCalledTimes(2)
    } finally {
      strict.dispose()
    }
  })

  it('窗口内消息立即广播（聊天即时可见），KP 回复窗口后广播', async () => {
    const listener = vi.fn()
    room.subscribe(listener)
    // ws 层先 appendMessage 广播玩家消息，再进回合缓冲（bufferPlayerChat 只管缓冲）
    room.appendMessage(
      { id: 'msg_1', timestamp: Date.now(), role: 'player', playerName: 'alice', content: '即时可见' },
      { userId: 1, roleName: 'alice' },
    )
    room.bufferPlayerChat('alice', '即时可见', null, 1)

    const appended = listener.mock.calls
      .map((c) => c[0] as { type: string; payload?: { content?: string } })
      .filter((e) => e.type === 'message_appended')
    expect(appended.some((e) => e.payload?.content === '即时可见')).toBe(true)
    expect(appended.some((e) => e.payload?.content?.includes('KP 回应'))).toBe(false) // KP 回复未到

    await new Promise((r) => setTimeout(r, 350))
    const after = listener.mock.calls
      .map((c) => c[0] as { type: string; payload?: { content?: string } })
      .filter((e) => e.type === 'message_appended')
    expect(after.some((e) => e.payload?.content?.includes('KP 回应'))).toBe(true)
  })

  it('空缓冲 flush 不触发 KP 回合', async () => {
    await room.flushTurn()
    expect(runKpTurnMock).not.toHaveBeenCalled()
  })

  it('D5：多角色工具分派——characterMutatorFactory 按 characterId 路由', async () => {
    room.bindCharacter(1, 'char_a', makeSheet('char_a'))
    room.bindCharacter(2, 'char_b', makeSheet('char_b'))
    // 直接调 runKpTurnForRoom，验证 factory 被传入
    await room.runKpTurnForRoom(1, [{ role: 'user', content: '测试' }], null, 'char_a', () => {})
    expect(runKpTurnMock).toHaveBeenCalledTimes(1)
    const factory = runKpTurnMock.mock.calls[0]![6]
    expect(typeof factory).toBe('function')
    // factory 返回的 mutator 集可用（updateCharacterHP 等）
    const m = (factory as (id: string | null) => { updateCharacterHP: (d: number) => void })(null)
    expect(typeof m.updateCharacterHP).toBe('function')
  })

  it('D5 归属校验：flushTurn 传入 allowedCharacterIds（窗口内行动者的卡集）', async () => {
    room.bindCharacter(1, 'char_a', makeSheet('char_a'))
    room.bindCharacter(2, 'char_b', makeSheet('char_b'))
    room.bufferPlayerChat('alice', '行动1', 'char_a', 1)
    room.bufferPlayerChat('bob', '行动2', 'char_b', 2)
    await new Promise((r) => setTimeout(r, 350))
    expect(runKpTurnMock).toHaveBeenCalledTimes(1)
    const allowed = runKpTurnMock.mock.calls[0]![7] as Set<string> | undefined
    expect(allowed).toBeDefined()
    expect(allowed!.has('char_a')).toBe(true)
    expect(allowed!.has('char_b')).toBe(true)
    // 未绑定角色卡的消息（characterId=null）不进入允许集
    expect(allowed!.has('')).toBe(false)
  })

  it('flush 竞态修复：flush 进行中到达的消息补触发（不挂起）', async () => {
    // 用延迟 Promise 模拟慢 LLM：第一次 flush 进行中，第二条消息到达
    let resolveFirst: (() => void) | null = null
    runKpTurnMock.mockImplementationOnce(async (...args) => {
      const handlers = args[5] as { onEnd: (r: unknown) => void }
      await new Promise<void>((r) => { resolveFirst = r })
      handlers.onEnd({ content: '第一次回复', displayMessages: [], toolCalls: [], worldDeltas: { cluesAdded: [] }, characterSheet: null })
    })
    const strict = new RoomService({ roomId: 'room_race', ownerId: 1, ownerName: 'alice', turnWindowMs: 0 })
    try {
      strict.bufferPlayerChat('alice', '第一条', null, 1)
      // 等第一次 flush 开始（turnFlushing=true）
      await new Promise((r) => setTimeout(r, 50))
      strict.bufferPlayerChat('bob', '第二条（flush 期间到达）', null, 2)
      resolveFirst!()
      // 等补触发 flush 处理第二条
      await new Promise((r) => setTimeout(r, 100))
      expect(runKpTurnMock).toHaveBeenCalledTimes(2)
    } finally {
      strict.dispose()
    }
  })

  it('dispose 清理回合窗口定时器', async () => {
    room.bufferPlayerChat('alice', '触发窗口', null, 1)
    room.dispose()
    // dispose 后不应再有 flush（timer 清理）
    await new Promise((r) => setTimeout(r, 350))
    expect(runKpTurnMock).not.toHaveBeenCalled()
  })
})
