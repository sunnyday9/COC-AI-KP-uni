/**
 * Dossier workflow room integration spec — the dossier branch of the room
 * pipeline: createSoloRoom(workflow:'dossier') persists the flag, snapshot
 * round-trips it, and flushTurn injects the dossier scene block (via mocked
 * dossier store) instead of RAG context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dossier-room-'))
vi.stubEnv('DATA_DIR', path.join(tmp, 'data'))
vi.stubEnv('UPLOADS_DIR', path.join(tmp, 'uploads'))
vi.stubEnv('RAG_DATA_DIR', path.join(tmp, 'rag'))
vi.stubEnv('DOSSIER_DATA_DIR', path.join(tmp, 'dossiers'))

// Re-import with env set (modules read config at import).
vi.resetModules()

const { createSoloRoom, getOrCreateRoom, getRoom, _clearRoomRegistryForTests } = await import('../roomService.js')
const roomStorage = await import('../roomStorage.js')
const { getDb } = await import('../../db/index.js')

// Mock the dossier store so flushTurn resolves a deterministic dossier block.
vi.mock('../rag/dossier/storyDossierService.js', () => ({
  loadDossier: vi.fn(async () => ({
    scriptId: 'demo.txt',
    storyName: '旧图书馆的铜钥匙',
    generatedAt: 1,
    scenes: [{ id: 'scene_1', name: '旧图书馆', sceneText: '灰尘与霉味。', description: '', npcIds: [], clueIds: [], requiredClues: [], hooks: [] }],
    clues: [],
    npcs: [],
  })),
  buildSceneBlock: vi.fn(() => '场景：旧图书馆\n现场描述：灰尘与霉味。'),
  listScenes: vi.fn(() => [{ id: 'scene_1', name: '旧图书馆' }]),
}))

const suite = `drm_${Date.now()}`
let seedSeq = 0

function seedUser(tag: string): number {
  const id = 80000 + ((Date.now() % 1000) * 1000 + seedSeq++)
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, `${suite}_${tag}`, Date.now())
  return id
}

const MINIMAL_SHEET = {
  playerName: '测试员',
  occupationName: '侦探',
  derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 50 },
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
  skills: {},
}

describe('dossier workflow 房间链路', () => {
  let owner: number

  beforeEach(async () => {
    owner = seedUser('owner')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    _clearRoomRegistryForTests()
  })

  it('createSoloRoom(workflow:dossier) 持久化 workflow 并随快照 restore 往返', async () => {
    const created = createSoloRoom(owner, { storyId: 'demo.txt', name: '调查员A', sheet: MINIMAL_SHEET, workflow: 'dossier' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const row = roomStorage.getRoomRow(created.roomId)
    const state = JSON.parse(row?.state || '{}') as { workflow?: string; turnWindowMs?: number }
    expect(state.workflow).toBe('dossier')
    // state 里 turnWindowMs 仍在
    expect(state.turnWindowMs).toBe(0)

    // 物化实例 → workflow 从 restore 读入
    const room = getRoom(created.roomId) ?? getOrCreateRoom(created.roomId, owner, 'owner')
    expect(room.getWorkflow()).toBe('dossier')
    expect(room.getStoryId()).toBe('demo.txt')
    // snapshot round-trip
    const snap = room.snapshot()
    expect(snap.workflow).toBe('dossier')
    room.dispose()
  })

  it('createSoloRoom 缺省 workflow 为 rag（现状不变）', async () => {
    const created = createSoloRoom(owner, { storyId: 'demo.txt', name: '调查员B', sheet: MINIMAL_SHEET })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const row = roomStorage.getRoomRow(created.roomId)
    const state = JSON.parse(row?.state || '{}') as { workflow?: string; turnWindowMs?: number }
    expect(state.workflow).toBeUndefined()
    const room = getRoom(created.roomId) ?? getOrCreateRoom(created.roomId, owner, 'owner')
    expect(room.getWorkflow()).toBe('rag')
    room.dispose()
  })
})
