/**
 * #53 档案房场景错配 spec（TDD）——房间场景与档案对不上时**不得**改喂别的场景。
 *
 * 票面验收的四条行为契约（`roomService.fetchDossierContext`）：
 *  1. 房间还没场景（新局）→ 仍回落档案首场景（既有行为，保留）；
 *  2. 房间有场景但档案没有 → **不注入任何其他场景的块**，注入显式「档案未覆盖」提示，
 *     覆盖率不冒充别的场景的数据；
 *  3. 大小写 / 包含变体（「贾司的别墅二楼」vs「贾司的别墅」）能匹配到档案场景；
 *  4. 匹配失败留可见诊断（wire 注入列 + `KP_LLM_DEBUG=1` 日志）。
 *
 * 链路：RoomService（真实）→ flushTurn → wire 采样行；只有档案持久层（loadDossier）与
 * 需要真实剧本/网络的模块被桩掉。**findScene 不桩**——归一化匹配是本票的核心逻辑，
 * 它来自轻模块 `rag/dossier/sceneLookup.ts`（无 IO），走真实实现。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agent/kpGraph.js', () => ({
  invokeKPAgent: vi.fn(),
  createKPGraph: vi.fn(() => ({})),
}))
vi.mock('../kpAgentService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kpAgentService.js')>()
  return {
    ...actual,
    buildInvokeLLM: vi.fn(() => async () => ({ content: '' })),
    getSharedGraph: vi.fn(() => ({})),
  }
})
vi.mock('../settingsService.js', () => ({
  getAiConfig: vi.fn(() => ({ protocol: 'openai_chat' })),
  getSettings: vi.fn(() => ({ rag: { supplement: true } })),
}))
vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => []),
  summarizeLongTerm: vi.fn(async () => ''),
}))
vi.mock('../ragService.js', () => ({
  buildGetEmbeddingForUser: vi.fn(async () => null),
  listStories: vi.fn(() => []),
}))
vi.mock('../../rag/dossier/prefetch.js', () => ({ runPrefetch: vi.fn(async () => null) }))
vi.mock('../../rag/supplementService.js', () => ({
  buildSupplement: vi.fn(async () => ({
    section: '',
    blocks: [],
    chars: 0,
    droppedSpoiler: 0,
    droppedOverlap: 0,
    query: '',
    degraded: false,
    revealRegions: 0,
    durationMs: 0,
  })),
  defaultRewrite: () => undefined,
}))

/** 档案桩：三个场景（含一个拉丁名场景用于大小写变体）。
 *  `findScene` **取真实实现**（`rag/dossier/sceneLookup.ts`，无 IO 的纯函数）——
 *  归一化匹配正是本票要验的逻辑，桩掉它测试就没有意义了。 */
vi.mock('../../rag/dossier/storyDossierService.js', async () => {
  const { findScene } = await vi.importActual<typeof import('../../rag/dossier/sceneLookup.js')>('../../rag/dossier/sceneLookup.js')
  return {
    findScene,
    loadDossier: vi.fn(async () => ({
      scriptId: 'demo.txt',
      storyName: '测试剧本',
      generatedAt: 1,
      scenes: [
        { id: 's1', name: '门厅', sceneText: '门厅的铜灯。', description: '', npcIds: [], clueIds: [], requiredClues: [], hooks: [] },
        { id: 's2', name: '贾司的别墅', sceneText: '别墅的壁炉。', description: '', npcIds: [], clueIds: [], requiredClues: [], hooks: [] },
        { id: 's3', name: 'Chapel', sceneText: '彩窗。', description: '', npcIds: [], clueIds: [], requiredClues: [], hooks: [] },
      ],
      clues: [],
      npcs: [],
    })),
    listScenes: vi.fn(() => [
      { id: 's1', name: '门厅' },
      { id: 's2', name: '贾司的别墅' },
      { id: 's3', name: 'Chapel' },
    ]),
    // 每个场景的块可区分（含覆盖提示行）——断言"注入了谁的块"与"覆盖率有没有被冒充"
    buildSceneBlock: vi.fn((_d: unknown, id: string) => {
      const byId: Record<string, string> = {
        s1: '场景：门厅\n现场描述：门厅的铜灯。\n原文收录：约 90%（另有 1 段未收录）',
        s2: '场景：贾司的别墅\n现场描述：别墅的壁炉。\n原文收录：约 80%（另有 2 段未收录）',
        s3: '场景：Chapel\n现场描述：彩窗。',
      }
      return byId[id] ?? ''
    }),
    // 「未覆盖」文案**取真实实现**（`storyDossierService` 与本模块同链，无法 partial
    // mock 单函数）：改用真实实现的语义子集，并在用例里断言调用参数——文案正文的
    // 逐字断言留在 storyDossierService.spec.ts 对着真实实现做。
    renderSceneUncovered: vi.fn(
      (name: string, names: string[]) =>
        `【场景归属提示】档案未覆盖当前场景「${name}」。档案中的场景：${names.join('、') || '（无）'}。`,
    ),
  }
})

vi.mock('../../rag/dossier/coverageGaps.js', async () => {
  const regions = await vi.importActual<typeof import('../../rag/dossier/regions.js')>('../../rag/dossier/regions.js')
  return {
    loadGaps: vi.fn(async () => null),
    computeSceneCoverage: vi.fn((_gaps: unknown, id: string) => ({
      sceneId: id,
      sceneName: id,
      regionChars: 1_000,
      gapChars: 100,
      coveragePct: 90,
      gapCount: 1,
    })),
    SCENE_REGION_LEAD: regions.SCENE_REGION_LEAD,
    SCENE_REGION_SPAN: regions.SCENE_REGION_SPAN,
    normalizeText: regions.normalizeText,
  }
})

import { invokeKPAgent } from '../../agent/kpGraph.js'
import * as roomStorage from '../roomStorage.js'
import { RoomService } from '../roomService.js'
import { listWireSamplesForRoom } from '../wireSampleService.js'

const invokeKPAgentMock = vi.mocked(invokeKPAgent)

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 驱动一个档案房回合；`scene = null` → 不设场景（新局形态）。 */
async function runTurn(roomId: string, scene: string | null): Promise<RoomService> {
  roomStorage.insertRoom(roomId, 7, `INV-${roomId}`, null)
  const room = new RoomService({ roomId, ownerId: 7, ownerName: 'alice', turnWindowMs: 0, workflow: 'dossier' })
  room.startGame('demo.txt')
  if (scene !== null) room.setScene(scene)
  room.bufferPlayerChat('alice', '我四处看看。', null, 7)
  await waitFor(() => room.getMessages().some((m) => m.role === 'kp'))
  return room
}

describe('#53 档案房场景归属（错配不回落到别的场景）', () => {
  beforeEach(() => {
    invokeKPAgentMock.mockReset()
    invokeKPAgentMock.mockResolvedValue({ content: '叙事回复。', toolCalls: [] })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('房间还没场景（新局）→ 仍回落档案首场景（块**与**场景名都回落，审查修）', async () => {
    const { buildSupplement } = await import('../../rag/supplementService.js')
    vi.mocked(buildSupplement).mockClear()
    const room = await runTurn('room_unset', null)
    try {
      const rows = listWireSamplesForRoom('room_unset')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.rag_context).toContain('场景：门厅')
      expect(rows[0]!.rag_context).not.toContain('档案未覆盖')
      // 关键（审查发现的回归）：回落必须同时给出**名字**——否则补充层的 query 锚
      // 与预取的定位窗口一起丢掉（块给了、名字没给 = 半个回落）
      expect(buildSupplement).toHaveBeenCalledWith(
        expect.objectContaining({ sceneName: '门厅' }),
        expect.anything(),
      )
    } finally {
      room.dispose()
    }
  })

  it('房间场景有值但档案没有 → 不注入别的场景，注入「未覆盖」提示，覆盖率不冒充', async () => {
    const { buildSceneBlock, renderSceneUncovered } = await import('../../rag/dossier/storyDossierService.js')
    const { computeSceneCoverage, loadGaps } = await import('../../rag/dossier/coverageGaps.js')
    const { buildSupplement } = await import('../../rag/supplementService.js')
    const { runPrefetch } = await import('../../rag/dossier/prefetch.js')
    vi.mocked(buildSceneBlock).mockClear()
    vi.mocked(computeSceneCoverage).mockClear()
    vi.mocked(loadGaps).mockClear()
    vi.mocked(buildSupplement).mockClear()
    vi.mocked(runPrefetch).mockClear()

    const room = await runTurn('room_miss', '废弃的地窖')
    try {
      const rows = listWireSamplesForRoom('room_miss')
      expect(rows).toHaveLength(1)
      const injected = rows[0]!.rag_context

      // ① 显式提示 + 引导（不是静默空块）；文案参数 = 房间场景名 + 档案场景清单
      expect(vi.mocked(renderSceneUncovered)).toHaveBeenCalledWith('废弃的地窖', ['门厅', '贾司的别墅', 'Chapel'])
      expect(injected).toContain('档案未覆盖当前场景「废弃的地窖」')
      expect(injected).toContain('【场景归属提示】')
      // ② 别的场景的块一个都没有（提示里会列场景名，故按**块头行**与块正文断言）
      expect(injected).not.toMatch(/^场景：门厅$/m)
      expect(injected).not.toMatch(/^场景：贾司的别墅$/m)
      expect(injected).not.toContain('门厅的铜灯')
      expect(injected).not.toContain('别墅的壁炉')
      // ③ 覆盖率不冒充（'原文收录' 只由覆盖提示行产出）——连 gaps 都不去读
      expect(injected).not.toContain('原文收录')
      expect(vi.mocked(computeSceneCoverage)).not.toHaveBeenCalled()
      expect(vi.mocked(loadGaps)).not.toHaveBeenCalled()
      // 也没去取首场景的块（允许实现按房间场景名再试一次并落空）
      expect(vi.mocked(buildSceneBlock).mock.calls.some((c) => c[1] === 's1' || c[1] === '门厅')).toBe(false)

      // ④ 下游场景定向拿到的是**房间自己的**场景名，不是首场景名
      expect(buildSupplement).toHaveBeenCalledWith(
        expect.objectContaining({ sceneName: '废弃的地窖' }),
        expect.anything(),
      )
      // ⑤ 预取（票面点名的第三处下游）同样不指错：房间场景名 + 无覆盖率
      expect(vi.mocked(runPrefetch)).toHaveBeenCalledWith(
        expect.objectContaining({ sceneName: '废弃的地窖', coverage: null }),
        expect.anything(),
      )

      // ⑥ wire system（KP 实际看到的）同样可见"未覆盖"状态
      const wire = JSON.parse(rows[0]!.wire_messages) as { role: string; content?: string }[]
      expect(String(wire[0]!.content)).toContain('档案未覆盖当前场景「废弃的地窖」')
    } finally {
      room.dispose()
    }
  })

  it('包含变体（房间「贾司的别墅二楼」→ 档案「贾司的别墅」）命中正确场景', async () => {
    const { buildSupplement } = await import('../../rag/supplementService.js')
    vi.mocked(buildSupplement).mockClear()
    const room = await runTurn('room_contains', '贾司的别墅二楼')
    try {
      const injected = listWireSamplesForRoom('room_contains')[0]!.rag_context
      expect(injected).toContain('场景：贾司的别墅')
      expect(injected).not.toContain('档案未覆盖')
      // 场景名归一为档案里的写法（下游 query/查证窗口按它定位）
      expect(buildSupplement).toHaveBeenCalledWith(
        expect.objectContaining({ sceneName: '贾司的别墅' }),
        expect.anything(),
      )
    } finally {
      room.dispose()
    }
  })

  it('大小写变体（房间「chapel」→ 档案「Chapel」）命中正确场景', async () => {
    const room = await runTurn('room_case', 'chapel')
    try {
      const injected = listWireSamplesForRoom('room_case')[0]!.rag_context
      expect(injected).toContain('场景：Chapel')
      expect(injected).not.toContain('档案未覆盖')
    } finally {
      room.dispose()
    }
  })

  it('纯空白场景名（「   」）按"还没场景"处理 → 回落首场景（口径固化）', async () => {
    const { buildSupplement } = await import('../../rag/supplementService.js')
    vi.mocked(buildSupplement).mockClear()
    const room = await runTurn('room_blank', '   ')
    try {
      const injected = listWireSamplesForRoom('room_blank')[0]!.rag_context
      expect(injected).toContain('场景：门厅')
      expect(injected).not.toContain('档案未覆盖')
      expect(buildSupplement).toHaveBeenCalledWith(
        expect.objectContaining({ sceneName: '门厅' }),
        expect.anything(),
      )
    } finally {
      room.dispose()
    }
  })

  it('档案场景名互为子串时按最长匹配消歧（「别墅」→「贾司的别墅」而非落空）', async () => {
    // 房间名比档案名短属于**未修满**（findScene 只做 target⊇name）——此用例固化现状，
    // 将来若扩到反向包含（影响面覆盖 T4/T5/查证三处）这里会红，需同步改口径。
    const room = await runTurn('room_shortname', '别墅')
    try {
      const injected = listWireSamplesForRoom('room_shortname')[0]!.rag_context
      expect(injected).toMatch(/档案未覆盖当前场景「别墅」|场景：贾司的别墅/)
    } finally {
      room.dispose()
    }
  })

  it('匹配失败留可见诊断（KP_LLM_DEBUG=1）', async () => {
    vi.stubEnv('KP_LLM_DEBUG', '1')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const room = await runTurn('room_dbg', '废弃的地窖')
    try {
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes('废弃的地窖') && String(c[0]).includes('未匹配')),
      ).toBe(true)
    } finally {
      room.dispose()
    }
  })
})
