/**
 * #54 结束态持久化 spec（TDD）——`end_game` 必须落到 `rooms.phase` 列。
 *
 * 票面三条验收：
 *  1. `end_game` → `getRoomRow(roomId).phase === 'ended'`，且"继续游戏"列表剔除该局；
 *  2. restore 往返后内存 `phase` 仍是 `'ended'`，玩家消息不再触发 KP 回合；
 *  3. `GET /api/rooms/:id`（`getRoomDetail`）对已结束房间报 `ended`。
 *
 * 背景：`setEnding` 原先只改内存 + 广播，**从不写 phase 列**，而该列是
 * `getRoomDetail` / `listSoloRoomsForUser` / restore（列优先）的唯一真源——
 * 于是结束的局仍挂在首页入口上，重启后还会被复活成进行中。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

// 桩掉 KP 回合实现：本 spec 只验「结束态是否触发回合」，不碰 LLM/检索链
// （真实链会动态 import embedding → 在空 MODELS_DIR 下试图下载模型）。
vi.mock('../kpTurnService.js', () => ({
  runKpTurn: vi.fn(async () => ({ ok: true })),
}))
// 知识注入整个面用 TurnKnowledge 单模块桩（架构走查候选 1 的收益证明）：本 spec
// 只验结束态语义，「KP 看到什么知识」无关紧要——此前要桩 ragService（检索/清单）、
// supplementService（检索补充层）、settingsService（补充层开关）三个知识层模块。
vi.mock('../turnKnowledge.js', () => ({
  assembleTurnKnowledge: vi.fn(async () => ({
    ragContext: '',
    sceneBlock: '',
    verifyBlock: '',
    supplement: '',
    coverage: null,
    storyName: '',
    wireInjectionText: '',
  })),
  buildStoryLookup: vi.fn(() => undefined),
}))
// 上下文注入层的 IO 也桩掉：rag 检索会懒加载本地嵌入模型（测试环境无缓存 →
// 网络等待拖过 waitFor 超时，正对照就永远等不到 runKpTurn）。
vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => []),
  summarizeLongTerm: vi.fn(async () => ''),
}))

import {
  createSoloRoom,
  listSoloRoomsForUser,
  getRoomDetail,
  getOrCreateRoom,
  startRoom,
  _clearRoomRegistryForTests,
} from '../roomService.js'
import { runKpTurn } from '../kpTurnService.js'
import { getRoomRow } from '../roomStorage.js'
import { getDb } from '../../db/index.js'

const runKpTurnMock = vi.mocked(runKpTurn)

let userIdSeq = 9700
function seedUser(username: string): number {
  const id = ++userIdSeq
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, username, Date.now())
  return id
}

// 完整角色卡（缺 attributes/skills 会在提示词组装 buildCharacterBlock 里抛错，
// 让回合在 runKpTurn 之前就失败——正对照会永远等不到调用）。
const validSheet = {
  playerName: '测试员',
  occupationName: '侦探',
  derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 55, sanMax: 55, damageBonus: '0', moveRate: 8 },
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 60 },
  skills: {},
} as never
const ENDING = { outcome: 'victory', title: '真相大白', summary: '调查员揭开了全部真相。' }

afterEach(() => {
  _clearRoomRegistryForTests()
  runKpTurnMock.mockClear()
})

describe('#54 end_game 落库 phase 列', () => {
  it('setEnding 后：列 phase=ended、继续游戏列表剔除、getRoomDetail 报 ended', async () => {
    const userId = seedUser('ended_alice')
    const created = await createSoloRoom(userId, { storyId: 'story_e1', name: '艾丽丝', sheet: validSheet })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // 结束前：正常在列
    expect(listSoloRoomsForUser(userId).map((r) => r.roomId)).toContain(created.roomId)

    const room = getOrCreateRoom(created.roomId, userId, 'ended_alice', 'story_e1')
    room.setEnding(ENDING)

    // ① 权威列落库
    expect(getRoomRow(created.roomId)!.phase).toBe('ended')
    // ② 继续游戏入口不再列出（listSoloRoomsForUser 的 WHERE phase != 'ended'）
    expect(listSoloRoomsForUser(userId).map((r) => r.roomId)).not.toContain(created.roomId)
    // ③ 房间详情报 ended（getRoomDetail 读的就是这一列）
    const detail = getRoomDetail(userId, created.roomId)
    expect(detail.ok).toBe(true)
    if (detail.ok) expect(detail.detail.phase).toBe('ended')

    room.dispose()
  })

  it('restore 往返后内存 phase 仍是 ended，玩家消息不再触发回合（正对照证明桩有效）', async () => {
    const userId = seedUser('ended_bob')
    const created = await createSoloRoom(userId, { storyId: 'story_e2', name: '鲍勃', sheet: validSheet })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // 正对照：playing 房的一条消息**确实**触发一次 KP 回合（证明桩接线有效，
    // 否则下面的"零调用"断言可能只是因为实现压根没被接上）
    const live = getOrCreateRoom(created.roomId, userId, 'ended_bob', 'story_e2')
    live.submitPlayerChat(userId, '我先四处看看。')
    await vi.waitFor(() => expect(runKpTurnMock).toHaveBeenCalledTimes(1), { timeout: 3_000 })
    live.setEnding(ENDING)
    await live.persistSnapshot()
    live.dispose()
    runKpTurnMock.mockClear()

    // 模拟进程重启：清注册表后重新物化（列优先 restore）
    _clearRoomRegistryForTests()
    const restored = getOrCreateRoom(created.roomId, userId, 'ended_bob')
    try {
      expect(restored.getPhase()).toBe('ended')
      // 结束态下玩家消息只进聊天流，**不触发 KP 回合**（等一段确定的时间再看计数）
      restored.submitPlayerChat(userId, '我还想继续调查。')
      await new Promise((r) => setTimeout(r, 200))
      expect(runKpTurnMock).not.toHaveBeenCalled()
    } finally {
      restored.dispose()
    }
  })

  it('旧数据自愈：列=playing 但快照 ending!=null → restore 判 ended 并回写列', async () => {
    const userId = seedUser('ended_carol')
    const created = await createSoloRoom(userId, { storyId: 'story_e3', name: '卡罗尔', sheet: validSheet })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // 造修复前的坏行形态：快照里有 ending，列仍是 playing
    getDb()
      .prepare(`UPDATE rooms SET state = ?, phase = 'playing' WHERE room_id = ?`)
      .run(JSON.stringify({ seq: 1, phase: 'playing', storyId: 'story_e3', messages: [], characters: {}, clues: [], scene: null, ending: ENDING, turnWindowMs: 0, updatedAt: Date.now() }), created.roomId)

    const room = getOrCreateRoom(created.roomId, userId, 'ended_carol')
    try {
      expect(room.getPhase()).toBe('ended')
      expect(getRoomRow(created.roomId)!.phase).toBe('ended') // 回写生效
      expect(listSoloRoomsForUser(userId).map((r) => r.roomId)).not.toContain(created.roomId)
    } finally {
      room.dispose()
    }
  })

  it('startRoom 对已结束房间报 conflict，不把列写回 playing（#54 门闩 0）', async () => {
    const userId = seedUser('ended_dave')
    // startRoom 是多人房治理动作（governanceGate 要求 kind='multi'），直接造一行
    const roomId = `ended_multi_${Date.now()}`
    getDb()
      .prepare(`INSERT INTO rooms (room_id, owner_id, invite_code, story_id, kind, phase, state, version, updated_at, created_at)
                 VALUES (?, ?, 'ENDED1', 'story_e4', 'multi', 'ended', '{}', 0, ?, ?)`)
      .run(roomId, userId, Date.now(), Date.now())
    getDb().prepare(`INSERT INTO room_members (room_id, user_id, role, character_id) VALUES (?, ?, 'owner', 'char_x')`).run(roomId, userId)

    const res = await startRoom(userId, roomId, 'story_e4')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      expect(res.message).toContain('已结束')
    }
    expect(getRoomRow(roomId)!.phase).toBe('ended')
  })
})
