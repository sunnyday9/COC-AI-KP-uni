/**
 * Solo 房间领域直测（ADR-0002：单人=单成员房间）——RoomService 领域方法缝，
 * node:sqlite 临时库（test/setup.ts 每 worker 独立 DATA_DIR），唯一 id 隔离用例。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  createSoloRoom,
  listRoomsForUser,
  listSoloRoomsForUser,
  getRoomDetail,
  getOrCreateRoom,
  setRoomTurnWindow,
  _clearRoomRegistryForTests,
} from '../roomService.js'
import { getRoomRow } from '../roomStorage.js'
import { getDb } from '../../db/index.js'
import { GAPS_VERSION } from '../../rag/dossier/coverageGaps.js'

const listStoriesMock = vi.hoisted(() => vi.fn())
vi.mock('../ragService.js', () => ({ listStories: listStoriesMock }))

const listDossiersMock = vi.hoisted(() => vi.fn())
const loadDossierMock = vi.hoisted(() => vi.fn())
vi.mock('../../rag/dossier/dossierCore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rag/dossier/dossierCore.js')>()
  return {
    ...actual,
    listDossiers: listDossiersMock,
    listDossiersWithDiagnostics: async (ownerId: number) => ({
      items: await listDossiersMock(ownerId),
      failureReason: null,
    }),
    loadDossier: loadDossierMock,
  }
})

const loadGapsMock = vi.hoisted(() => vi.fn())
vi.mock('../../rag/dossier/coverageGaps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rag/dossier/coverageGaps.js')>()
  return { ...actual, loadGaps: loadGapsMock }
})

const suite = `solo_${Date.now()}`

let userIdSeq = 9520
function seedUser(username: string): number {
  const id = ++userIdSeq
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, username, Date.now())
  return id
}

const validSheet = {
  derived: { hp: 10, mp: 8, san: 55, luck: 60, damageBonus: '0', moveRate: 8 },
} as never

afterEach(() => {
  _clearRoomRegistryForTests()
})

beforeEach(() => {
  const stories = [
    { storyId: 'story_solo_a', name: 'a', chunkCount: 1, indexedAt: 1 },
    { storyId: 'story_w', name: 'w', chunkCount: 1, indexedAt: 1 },
    { storyId: 'story_c', name: 'c', chunkCount: 1, indexedAt: 1 },
    { storyId: 'story_c2', name: 'c2', chunkCount: 1, indexedAt: 1 },
    { storyId: 'story_e', name: 'e', chunkCount: 1, indexedAt: 1 },
  ]
  listStoriesMock.mockReturnValue(stories)
  listDossiersMock.mockResolvedValue(stories.map(({ storyId, name }) => ({
    scriptId: storyId,
    name,
    sceneCount: 1,
    generatedAt: 1,
    degraded: false,
    coveragePct: 100,
  })))
  loadDossierMock.mockImplementation(async (_ownerId: number, scriptId: string) => ({
    scriptId,
    storyName: scriptId,
    generatedAt: 1,
    scenes: [{ id: 'reveal', name: '终幕', sceneText: '终幕原文' }],
    clues: [],
    npcs: [],
    truths: [{ id: 'truth_finale', title: '幕后真相', detail: '真相细节', revealScene: 'reveal' }],
    endings: [],
  }))
  loadGapsMock.mockImplementation(async (_ownerId: number, scriptId: string) => ({
    scriptId,
    gapsVersion: GAPS_VERSION,
    storyChars: 20_000,
    sceneTextChars: 4,
    gapCount: 0,
    gapChars: 0,
    gapPct: 0,
    spans: [],
    sceneAnchors: [{ id: 'reveal', name: '终幕', matched: true, starts: [12_000] }],
  }))
})

describe('createSoloRoom 一体领域动作', () => {
  it('落角色卡 + 建 solo 房 + 绑卡 + start 一步完成', async () => {
    const userId = seedUser('solo_alice')
    const result = await createSoloRoom(userId, { storyId: 'story_solo_a', name: '艾丽丝', sheet: validSheet })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = getRoomRow(result.roomId)!
    expect(row.kind).toBe('solo')
    expect(row.phase).toBe('playing')
    expect(row.story_id).toBe('story_solo_a')
    expect(JSON.parse(row.state)).toEqual({ turnWindowMs: 0 })

    const owner = getDb().prepare(`SELECT user_id FROM characters WHERE id = ?`).get(result.characterId) as { user_id: number }
    expect(owner.user_id).toBe(userId)

    const member = getDb().prepare(`SELECT role, character_id FROM room_members WHERE room_id = ? AND user_id = ?`).get(result.roomId, userId) as {
      role: string
      character_id: string
    }
    expect(member.role).toBe('owner')
    expect(member.character_id).toBe(result.characterId)
  })

  it('缺 storyId / 缺 name / 缺 sheet → bad-request，不落任何行', async () => {
    const userId = seedUser('solo_bob')
    expect((await createSoloRoom(userId, { storyId: '', name: 'x', sheet: validSheet })).ok).toBe(false)
    expect((await createSoloRoom(userId, { storyId: 's', name: '', sheet: validSheet })).ok).toBe(false)
    expect((await createSoloRoom(userId, { storyId: 's', name: 'x', sheet: {} })).ok).toBe(false)
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM rooms r JOIN room_members m ON r.room_id = m.room_id WHERE m.user_id = ? AND r.kind = 'solo'`).get(userId) as { n: number }
    expect(count.n).toBe(0)
  })

  it('solo 房回合窗口不可设置（ADR-0002 恒 0）', async () => {
    const userId = seedUser('solo_window')
    const result = await createSoloRoom(userId, { storyId: 'story_w', name: '温蒂', sheet: validSheet })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const fail = setRoomTurnWindow(userId, result.roomId, 5000)
    expect(fail.ok).toBe(false)
    if (!fail.ok) expect(fail.reason).toBe('bad-request')
  })
})

describe('solo 房间列表可见性', () => {
  it('listRoomsForUser 不含 solo；listSoloRoomsForUser 只列本人未结束 solo', async () => {
    const userId = seedUser('solo_carol')
    const otherId = seedUser('solo_dave')
    const solo = await createSoloRoom(userId, { storyId: 'story_c', name: '卡罗尔', sheet: validSheet })
    expect(solo.ok).toBe(true)
    // multi 房（同用户）与 ended solo（应被继续游戏排除）
    getDb().prepare(`INSERT INTO rooms (room_id, owner_id, invite_code, story_id, kind, phase, state, version, updated_at, created_at)
                     VALUES (?, ?, 'MULTE1', null, 'multi', 'lobby', '{}', 0, ?, ?)`).run(`${suite}_m1`, userId, Date.now(), Date.now())
    getDb().prepare(`INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'owner')`).run(`${suite}_m1`, userId)
    const endedSolo = await createSoloRoom(userId, { storyId: 'story_c2', name: '卡罗尔二', sheet: validSheet })
    if (endedSolo.ok) {
      getDb().prepare(`UPDATE rooms SET phase = 'ended' WHERE room_id = ?`).run(endedSolo.roomId)
    }

    const multiIds = listRoomsForUser(userId).map((r) => r.roomId)
    expect(multiIds).toContain(`${suite}_m1`)
    expect(multiIds).not.toContain(solo.ok ? solo.roomId : '')

    const soloIds = listSoloRoomsForUser(userId).map((r) => r.roomId)
    expect(soloIds).toEqual(solo.ok ? [solo.roomId] : []) // ended 被排除
    expect(listSoloRoomsForUser(otherId)).toEqual([]) // 他人不可见
  })
})

describe('solo 房间 wire 面与 multi 一致', () => {
  it('getRoomDetail 成员可见、joinRoom 可进（懒激活物化）', async () => {
    const userId = seedUser('solo_eve')
    const result = await createSoloRoom(userId, { storyId: 'story_e', name: '伊芙', sheet: validSheet })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const detail = getRoomDetail(userId, result.roomId)
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      expect(detail.detail.phase).toBe('playing')
      expect(detail.detail.ownerId).toBe(userId)
    }
    const room = getOrCreateRoom(result.roomId, userId, 'solo_eve')
    expect(room).not.toBeNull()
    expect(room!.getPhase()).toBe('playing')
    expect(room!.getTurnWindowMs()).toBe(0)
  })
})
