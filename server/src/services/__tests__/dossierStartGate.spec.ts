/**
 * #55 开局门闩（产物期）spec —— 低覆盖/分节失败的残档不再静默放行：
 *  - startRoom（多人 lobby 开局）：dossier 分支在「已生成」检查后追加降质判定；
 *  - createSoloRoom（solo 出生即 playing，**不经 startRoom**）：dossier workflow
 *    同样拦降质档案——A/B harness 走的正是 POST /api/rooms/solo；
 *  - 「生成了但质量不足」的 409 文案与「尚未生成档案」严格分开（缺档案指引
 *    生成，残档指引重生成）。
 * startGate（门闩判定单源，架构走查候选 4 收编自 roomService）动态 import 的轻核
 * dossierCore 只 mock `listDossiers`（磁盘扫描缝）；降质判定走真实纯函数
 * `dossierGateNotice`（无 IO）——门闩到文案的整条链在本 spec 内真实验证。
 * 判定的快照/兜底语义由 storyDossierService.spec / schema.spec 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../../db/index.js'
import {
  _clearRoomRegistryForTests,
  bindRoomCharacter,
  createRoom,
  createSoloRoom,
  joinRoomByInviteCode,
  startRoom,
} from '../roomService.js'

const listStoriesMock = vi.hoisted(() => vi.fn())
vi.mock('../ragService.js', () => ({ listStories: listStoriesMock }))

const listDossiersMock = vi.hoisted(() => vi.fn())
const loadDossierMock = vi.hoisted(() => vi.fn())
vi.mock('../../rag/dossier/dossierCore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rag/dossier/dossierCore.js')>()
  return { ...actual, listDossiers: listDossiersMock, loadDossier: loadDossierMock }
})

const loadGapsMock = vi.hoisted(() => vi.fn())
vi.mock('../../rag/dossier/coverageGaps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rag/dossier/coverageGaps.js')>()
  return { ...actual, loadGaps: loadGapsMock }
})

/** 造一条清单记录（其余字段门闩不读）。 */
function item(scriptId: string, quality: { degraded?: boolean; coveragePct?: number; failedBatches?: number }) {
  return { scriptId, name: 'x', sceneCount: 3, generatedAt: 1, ...quality }
}

function usableRagDossier(scriptId: string) {
  return {
    scriptId,
    storyName: 'x',
    generatedAt: 1,
    scenes: [{ id: 'reveal', name: '终幕', sceneText: '终幕原文' }],
    clues: [],
    npcs: [],
    truths: [{ title: '幕后真相', detail: '真相细节', revealScene: 'reveal' }],
  }
}

function usableRagGaps(scriptId: string) {
  return {
    scriptId,
    storyChars: 20000,
    sceneTextChars: 4,
    gapCount: 0,
    gapChars: 0,
    gapPct: 0,
    spans: [],
    sceneAnchors: [{ id: 'reveal', name: '终幕', matched: true, starts: [12000] }],
  }
}

const MISSING_MSG = '该剧本尚未生成档案，请先在「我的故事」中为剧本生成档案'

const suite = `g55_${Date.now()}`
let seedSeq = 0
let charSeq = 0

function seedUser(tag: string): number {
  const id = 91000 + ((Date.now() % 1000) * 1000 + seedSeq++)
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, `${suite}_${tag}`, Date.now())
  return id
}

function seedChar(userId: number, tag: string): string {
  // id 带自增序列：多个用例可能落在同一毫秒（suite 同串），纯 tag 会撞
  // INSERT OR IGNORE 静默跳过 → 角色卡归属上一个用例的用户 → 绑定静默失败
  const id = `char_${suite}_${tag}_${charSeq++}`
  getDb().prepare(`INSERT OR IGNORE INTO characters (id, user_id, name, sheet, updated_at) VALUES (?, ?, '{}', ?, ?)`).run(id, userId, `卡_${tag}`, Date.now())
  return id
}

const MINIMAL_SHEET = {
  playerName: '测试员',
  occupationName: '侦探',
  derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 50 },
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
  skills: {},
}

beforeEach(() => {
  listStoriesMock.mockReturnValue([])
  listDossiersMock.mockReset()
  loadDossierMock.mockReset().mockResolvedValue(null)
  loadGapsMock.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  _clearRoomRegistryForTests()
})

describe('#55 startRoom 门闩（dossier workflow）', () => {
  it('残档（degraded）→ conflict 提示重新生成，文案不是「尚未生成档案」', async () => {
    const owner = seedUser('sr_owner')
    const memberA = seedUser('sr_a')
    const created = createRoom(owner, null, { workflow: 'dossier' })
    joinRoomByInviteCode(memberA, created.inviteCode)
    bindRoomCharacter(owner, created.roomId, seedChar(owner, 'oc'))
    bindRoomCharacter(memberA, created.roomId, seedChar(memberA, 'ac'))

    listDossiersMock.mockResolvedValue([item('story_x', { degraded: true, coveragePct: 3, failedBatches: 3 })])

    const res = await startRoom(owner, created.roomId, 'story_x')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      // 真实纯函数产出的文案：点明覆盖率/分节失败 + 指引重生成
      expect(res.message).toContain('档案质量不足')
      expect(res.message).toContain('覆盖率仅 3%')
      expect(res.message).toContain('3 个分节解析失败')
      expect(res.message).toContain('重新生成')
      // 两条 409 不搅在一起
      expect(res.message).not.toBe(MISSING_MSG)
    }
  })

  it('健康档案（degraded=false）→ 门闩全过开局成功', async () => {
    const owner = seedUser('sr_ok_owner')
    const created = createRoom(owner, null, { workflow: 'dossier' })
    bindRoomCharacter(owner, created.roomId, seedChar(owner, 'oc'))

    listDossiersMock.mockResolvedValue([item('story_ok', { degraded: false, coveragePct: 54.7 })])

    const res = await startRoom(owner, created.roomId, 'story_ok')
    expect(res.ok).toBe(true)
  })

  it('旧档案（无质量数据 degraded=undefined）→ 放行', async () => {
    const owner = seedUser('sr_legacy_owner')
    const created = createRoom(owner, null, { workflow: 'dossier' })
    bindRoomCharacter(owner, created.roomId, seedChar(owner, 'oc'))

    listDossiersMock.mockResolvedValue([item('story_legacy', {})])

    const res = await startRoom(owner, created.roomId, 'story_legacy')
    expect(res.ok).toBe(true)
  })

  it('未生成档案 → 维持原有「尚未生成档案」文案（回归钉住）', async () => {
    const owner = seedUser('sr_miss_owner')
    const created = createRoom(owner, null, { workflow: 'dossier' })
    bindRoomCharacter(owner, created.roomId, seedChar(owner, 'oc'))

    listDossiersMock.mockResolvedValue([])

    const res = await startRoom(owner, created.roomId, 'story_none')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe(MISSING_MSG)
  })
})

describe('#55 createSoloRoom 门闩（solo 出生即 playing，不经 startRoom）', () => {
  it('workflow=dossier + 残档 → conflict，房间不落库', async () => {
    const owner = seedUser('so_bad_owner')
    listDossiersMock.mockResolvedValue([item('story_bad', { degraded: true, coveragePct: 3, failedBatches: 3 })])

    const res = await createSoloRoom(owner, { storyId: 'story_bad', name: '调查员', sheet: MINIMAL_SHEET, workflow: 'dossier' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      expect(res.message).toContain('档案质量不足')
      expect(res.message).toContain('重新生成')
      expect(res.message).not.toBe(MISSING_MSG)
    }
    // 一体动作在门闩处短路：角色卡/房间行都不落
    expect(getDb().prepare(`SELECT 1 FROM rooms WHERE owner_id = ?`).get(owner)).toBeUndefined()
  })

  it('workflow=dossier + 健康档案 → ok 照常开局', async () => {
    const owner = seedUser('so_ok_owner')
    listDossiersMock.mockResolvedValue([item('story_good', { degraded: false, coveragePct: 54.7 })])

    const res = await createSoloRoom(owner, { storyId: 'story_good', name: '调查员', sheet: MINIMAL_SHEET, workflow: 'dossier' })
    expect(res.ok).toBe(true)
  })

  it('workflow=dossier + 缺档案 → conflict，不创建 playing 房间', async () => {
    const owner = seedUser('so_missing_owner')
    listDossiersMock.mockResolvedValue([])

    const res = await createSoloRoom(owner, { storyId: 'story_missing', name: '调查员', sheet: MINIMAL_SHEET, workflow: 'dossier' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      expect(res.message).toBe(MISSING_MSG)
    }
    expect(getDb().prepare(`SELECT 1 FROM rooms WHERE owner_id = ?`).get(owner)).toBeUndefined()
  })

  it('缺省 workflow=rag + 未索引 → conflict，不创建 playing 房间', async () => {
    const owner = seedUser('so_unindexed_owner')
    listStoriesMock.mockReturnValue([])

    const res = await createSoloRoom(owner, { storyId: 'story_unindexed', name: '调查员', sheet: MINIMAL_SHEET })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      expect(res.message).toBe('该剧本尚未索引，请先在「我的故事」中完成索引')
    }
    expect(getDb().prepare(`SELECT 1 FROM rooms WHERE owner_id = ?`).get(owner)).toBeUndefined()
  })

  it('workflow=rag + 已索引但缺 gaps → conflict，不创建 playing 房间', async () => {
    const owner = seedUser('so_rag_missing_gaps')
    listStoriesMock.mockReturnValue([{ storyId: 'story_rag', name: 'x', chunkCount: 1, indexedAt: 1 }])
    listDossiersMock.mockResolvedValue([item('story_rag', { degraded: false, coveragePct: 54.7 })])
    loadDossierMock.mockResolvedValue(usableRagDossier('story_rag'))

    const res = await createSoloRoom(owner, { storyId: 'story_rag', name: '调查员', sheet: MINIMAL_SHEET })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      expect(res.message).toContain('剧透保护锚点')
    }
    expect(getDb().prepare(`SELECT 1 FROM rooms WHERE owner_id = ?`).get(owner)).toBeUndefined()
  })

  it('workflow=rag + 已索引且揭晓锚点可用 → ok', async () => {
    const owner = seedUser('so_rag_ready')
    listStoriesMock.mockReturnValue([{ storyId: 'story_rag_ready', name: 'x', chunkCount: 1, indexedAt: 1 }])
    listDossiersMock.mockResolvedValue([item('story_rag_ready', { degraded: false, coveragePct: 54.7 })])
    loadDossierMock.mockResolvedValue(usableRagDossier('story_rag_ready'))
    loadGapsMock.mockResolvedValue(usableRagGaps('story_rag_ready'))

    const res = await createSoloRoom(owner, { storyId: 'story_rag_ready', name: '调查员', sheet: MINIMAL_SHEET })
    expect(res.ok).toBe(true)
  })
})

describe('rag workflow multiplayer start gate', () => {
  it('已索引但 revealScene 未匹配 gaps 锚点 → conflict，房间保留 lobby', async () => {
    const owner = seedUser('multi_rag_missing_anchor')
    const created = createRoom(owner, null)
    bindRoomCharacter(owner, created.roomId, seedChar(owner, 'multi_rag_card'))
    listStoriesMock.mockReturnValue([{ storyId: 'story_multi', name: 'x', chunkCount: 1, indexedAt: 1 }])
    listDossiersMock.mockResolvedValue([item('story_multi', { degraded: false, coveragePct: 54.7 })])
    loadDossierMock.mockResolvedValue(usableRagDossier('story_multi'))
    loadGapsMock.mockResolvedValue({
      ...usableRagGaps('story_multi'),
      sceneAnchors: [{ id: 'reveal', name: '终幕', matched: false }],
    })

    const res = await startRoom(owner, created.roomId, 'story_multi')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('conflict')
      expect(res.message).toContain('剧透保护锚点')
    }
    expect(getDb().prepare(`SELECT phase FROM rooms WHERE room_id = ?`).get(created.roomId)).toEqual({ phase: 'lobby' })
  })

  it('已索引且 revealScene 锚点可用 → 多人开局成功', async () => {
    const owner = seedUser('multi_rag_ready')
    const created = createRoom(owner, null)
    bindRoomCharacter(owner, created.roomId, seedChar(owner, 'multi_rag_card'))
    listStoriesMock.mockReturnValue([{ storyId: 'story_multi_ready', name: 'x', chunkCount: 1, indexedAt: 1 }])
    listDossiersMock.mockResolvedValue([item('story_multi_ready', { degraded: false, coveragePct: 54.7 })])
    loadDossierMock.mockResolvedValue(usableRagDossier('story_multi_ready'))
    loadGapsMock.mockResolvedValue(usableRagGaps('story_multi_ready'))

    const res = await startRoom(owner, created.roomId, 'story_multi_ready')
    expect(res.ok).toBe(true)
  })
})
