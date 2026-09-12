/**
 * TurnKnowledge 直测（架构走查候选 1）：注入假知识层模块，断言 rag/dossier 两
 * workflow 的知识块装配与 wire 注入列拼装、落空降级。
 *
 * 此前「KP 本回合看到什么知识」以 6 个私有方法散在 RoomService 活跃实例里，测它要
 * mock 8-9 个深层模块（kpWireSampleRoom 8 个、dossierSceneMismatch 9 个 vi.mock）。
 * 收编后本 spec 只桩知识层实现（dossierCore / coverageGaps / supplementService /
 * prefetch / ragService / settingsService），对着唯一入口
 * `assembleTurnKnowledge` 断言装配语义；wire 注入列口径（ab-compare 报告依赖）在
 * 这里逐字固化。buildStoryLookup 只测「回合内要不要提供查证工具」的 workflow 门
 * 决策——四工具执行语义归档案域 dossierLookupTools（直测在
 * rag/dossier/__tests__/dossierLookupTools.spec.ts）。
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('../ragService.js', () => ({
  buildGetEmbeddingForUser: vi.fn(async () => null),
  // 注意：剧本名在 rag 清单与 dossier 档案两处给出**同一个**值——fetchStoryName 与
  // fetchDossierContext 在 Promise.all 里并发动态 import dossierCore，vitest mocker
  // 对并发同 specifier 的两次动态 import 有竞态（一个拿到 mock、一个拿到真实模块，
  // 真实模块无档案 → 回落清单）。这条竞态继承自原 RoomService 的同构装配结构
  // （行为零变化），生产侧无 mocker 不存在；此处让两个来源同名，断言与竞态解耦。
  listStories: vi.fn(() => [{ storyId: 'story_k', name: '雾中镇', chunkCount: 1, indexedAt: 0 }]),
}))
vi.mock('../settingsService.js', () => ({
  getSettings: vi.fn(() => ({ rag: { supplement: true } })),
}))
vi.mock('../../rag/supplementService.js', () => ({
  buildSupplement: vi.fn(async (_input: unknown, deps?: { onEvent?: (e: Record<string, unknown>) => void }) => {
    deps?.onEvent?.({ type: 'supplement-done' })
    return {
      section: '## 原文片段（检索补充·仅作描写素材）\n纹理块（桩）',
      blocks: [{ id: 'c1', text: 'RAG 检索上下文（桩）', score: 0.9, attribution: 'none', scenes: [], crossScene: false }],
      chars: 40,
      droppedSpoiler: 0,
      droppedOverlap: 0,
      query: '桩',
      degraded: false,
      revealRegions: 0,
      durationMs: 1,
    }
  }),
  defaultRewrite: vi.fn(() => undefined),
}))
vi.mock('../../rag/dossier/dossierCore.js', () => ({
  loadDossier: vi.fn(async () => ({
    scriptId: 'story_k',
    storyName: '雾中镇',
    generatedAt: 1,
    scenes: [{ id: 's1', name: '门厅', sceneText: '门厅的铜灯。', description: '', npcIds: [], clueIds: [], requiredClues: [], hooks: [] }],
    clues: [],
    npcs: [],
  })),
  buildSceneBlock: vi.fn((_d: unknown, id: string) => `场景：门厅（${id}）`),
  listScenes: vi.fn(() => [{ id: 's1', name: '门厅' }]),
  findScene: vi.fn(() => ({ id: 's1', name: '门厅' })),
  renderSceneUncovered: vi.fn((name: string, names: string[]) => `【场景归属提示】档案未覆盖当前场景「${name}」。档案中的场景：${names.join('、')}。`),
}))
vi.mock('../../rag/dossier/coverageGaps.js', () => ({
  loadGaps: vi.fn(async () => null),
  computeSceneCoverage: vi.fn(() => null),
}))
vi.mock('../../rag/dossier/prefetch.js', () => ({
  runPrefetch: vi.fn(async (_input: unknown, deps?: { onEvent?: (e: Record<string, unknown>) => void }) => {
    deps?.onEvent?.({ type: 'prefetch-decision', trigger: true })
    return { content: '查证结论（桩）：铜钥匙在门厅。', meta: { tier: 'scene', chars: 20, ok: true, durationMs: 1 } }
  }),
}))

import { assembleTurnKnowledge, buildStoryLookup } from '../turnKnowledge.js'
import { OPENING_RAG_QUERY } from '../kpPromptService.js'
import { buildSupplement } from '../../rag/supplementService.js'
import { runPrefetch } from '../../rag/dossier/prefetch.js'
import { loadDossier, buildSceneBlock, listScenes, findScene, renderSceneUncovered } from '../../rag/dossier/dossierCore.js'
import { loadGaps, computeSceneCoverage } from '../../rag/dossier/coverageGaps.js'
import { getSettings } from '../settingsService.js'
import { listStories, buildGetEmbeddingForUser } from '../ragService.js'

const baseInput = {
  ownerId: 7,
  storyId: 'story_k',
  roomId: 'room_k',
  scene: '门厅',
} as const

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('assembleTurnKnowledge — rag workflow（标准检索情报块，plain 模式）', () => {
  it('玩家回合：玩家发言当 rawQuery 检索，注入列回退情报块；补充层/预取均不发生', async () => {
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'rag', playerText: '【艾丽丝】我检查校门', stage: 'turn' })

    expect(buildSupplement).toHaveBeenCalledTimes(1)
    expect(buildSupplement).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        scriptId: 'story_k',
        rawQuery: '【艾丽丝】我检查校门',
        sceneName: '门厅',
        mode: 'plain',
        enabled: true,
      }),
      expect.anything(),
    )
    // 知识块：rag 情报块来自检索 blocks 渲染；dossier 场景块/补充层/预取全空
    expect(k.ragContext).toBe('RAG 检索上下文（桩）')
    expect(k.sceneBlock).toBe('')
    expect(k.supplement).toBe('')
    expect(k.verifyBlock).toBe('')
    expect(runPrefetch).not.toHaveBeenCalled()
    // 剧本名走 rag 索引清单
    expect(k.storyName).toBe('雾中镇')
    // 注入列口径：无场景块/补充小节 → 回退 ragContext
    expect(k.wireInjectionText).toBe('RAG 检索上下文（桩）')
  })

  it('opening：rag query 退化为开场固定 query（OPENING_RAG_QUERY），不触发预取', async () => {
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'rag', playerText: '', stage: 'opening' })

    expect(buildSupplement).toHaveBeenCalledWith(expect.objectContaining({ rawQuery: OPENING_RAG_QUERY }), expect.anything())
    expect(runPrefetch).not.toHaveBeenCalled()
    expect(k.wireInjectionText).toBe(k.ragContext)
  })
})

describe('assembleTurnKnowledge — dossier workflow（场景档案块 + 补充层 + 预取）', () => {
  it('玩家回合：场景块 + 补充小节 + 预取结论齐备，注入列 = 场景块\\n\\n补充小节', async () => {
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】钥匙在哪', stage: 'turn' })

    // 补充层走 supplement 模式（无 mode 字段）+ 玩家发言；rag 情报块恒空
    expect(buildSupplement).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, scriptId: 'story_k', playerText: '【艾丽丝】钥匙在哪', sceneName: '门厅' }),
      expect.anything(),
    )
    expect(vi.mocked(buildSupplement).mock.calls[0]![0].mode).toBeUndefined()
    expect(k.ragContext).toBe('')
    expect(k.sceneBlock).toBe('场景：门厅（s1）')
    expect(k.supplement).toBe('## 原文片段（检索补充·仅作描写素材）\n纹理块（桩）')
    // 预取拿到装配中间产物（场景块/场景名/覆盖度），结论进 verifyBlock
    expect(runPrefetch).toHaveBeenCalledWith(
      expect.objectContaining({ playerText: '【艾丽丝】钥匙在哪', sceneBlock: '场景：门厅（s1）', sceneName: '门厅', coverage: null }),
      expect.objectContaining({ userId: 7, scriptId: 'story_k' }),
    )
    expect(k.verifyBlock).toBe('查证结论（桩）：铜钥匙在门厅。')
    // 剧本名：dossier 档案 / rag 清单同源同名（见 mock 处竞态说明）
    expect(k.storyName).toBe('雾中镇')
    // 注入列口径：场景块在前、补充小节在后，双非空拼接
    expect(k.wireInjectionText).toBe('场景：门厅（s1）\n\n## 原文片段（检索补充·仅作描写素材）\n纹理块（桩）')
  })

  it('场景错配：不注入别的场景，走 renderSceneUncovered 分支，覆盖率不冒充（不读 gaps）', async () => {
    vi.mocked(findScene).mockReturnValueOnce(null)
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', scene: '废弃的地窖', playerText: '【艾丽丝】我四处看看', stage: 'turn' })

    expect(renderSceneUncovered).toHaveBeenCalledWith('废弃的地窖', ['门厅'])
    expect(k.sceneBlock).toBe('【场景归属提示】档案未覆盖当前场景「废弃的地窖」。档案中的场景：门厅。')
    expect(k.sceneName).toBe('废弃的地窖')
    expect(loadGaps).not.toHaveBeenCalled()
    expect(computeSceneCoverage).not.toHaveBeenCalled()
    // 预取定位窗口拿到的是房间自己的场景名 + 无覆盖率
    expect(runPrefetch).toHaveBeenCalledWith(
      expect.objectContaining({ sceneName: '废弃的地窖', coverage: null }),
      expect.anything(),
    )
  })

  it('opening：补充层 query 退化为空（纯场景名锚），预取不触发', async () => {
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '', stage: 'opening' })

    expect(buildSupplement).toHaveBeenCalledWith(expect.objectContaining({ playerText: '', sceneName: '门厅' }), expect.anything())
    expect(runPrefetch).not.toHaveBeenCalled()
    expect(k.verifyBlock).toBe('')
    expect(k.wireInjectionText).toBe('场景：门厅（s1）\n\n## 原文片段（检索补充·仅作描写素材）\n纹理块（桩）')
  })

  it('rag.supplement=false：不检索、不建嵌入器（零模型成本），注入列只剩场景块', async () => {
    vi.mocked(getSettings).mockReturnValueOnce({ rag: { supplement: false } } as never)
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】看看四周', stage: 'turn' })

    expect(buildSupplement).not.toHaveBeenCalled()
    expect(buildGetEmbeddingForUser).not.toHaveBeenCalled()
    expect(k.supplement).toBe('')
    expect(k.wireInjectionText).toBe('场景：门厅（s1）')
  })
})

describe('assembleTurnKnowledge — 落空降级（回合不因知识装配中断）', () => {
  it('未绑定剧本（storyId=null）：全部落空为空串，不触任何知识层模块', async () => {
    const k = await assembleTurnKnowledge({ workflow: 'dossier', ownerId: 7, storyId: null, roomId: 'room_k', scene: null, playerText: '【艾丽丝】在吗', stage: 'turn' })

    expect(k.ragContext).toBe('')
    expect(k.sceneBlock).toBe('')
    expect(k.supplement).toBe('')
    expect(k.verifyBlock).toBe('')
    expect(k.storyName).toBe('')
    expect(k.wireInjectionText).toBe('')
    expect(buildSupplement).not.toHaveBeenCalled()
    expect(runPrefetch).not.toHaveBeenCalled()
    expect(loadDossier).not.toHaveBeenCalled()
  })

  it('档案缺失（loadDossier → null）：场景块空、sceneName 落空，但补充层照常（场景名回落房间场景）', async () => {
    vi.mocked(loadDossier).mockResolvedValueOnce(null)
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】在吗', stage: 'turn' })

    expect(buildSceneBlock).not.toHaveBeenCalled()
    expect(listScenes).not.toHaveBeenCalled()
    expect(k.sceneBlock).toBe('')
    expect(k.sceneName).toBeUndefined()
    // 注入列口径：场景块空 → 拼装只剩补充小节（与原 flushTurn 装配逐字节同语义）
    expect(k.wireInjectionText).toBe('## 原文片段（检索补充·仅作描写素材）\n纹理块（桩）')
  })

  it('补充层检索抛错：降级为空小节，注入列回退场景块；预取照常', async () => {
    vi.mocked(buildSupplement).mockRejectedValueOnce(new Error('embedder down'))
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】钥匙在哪', stage: 'turn' })

    expect(k.supplement).toBe('')
    expect(k.verifyBlock).toBe('查证结论（桩）：铜钥匙在门厅。')
    expect(k.wireInjectionText).toBe('场景：门厅（s1）')
  })

  it('预取抛错（含动态 import 失败形态）：verifyBlock 降级为空串，回合照常', async () => {
    vi.mocked(runPrefetch).mockRejectedValueOnce(new Error('verify down'))
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】钥匙在哪', stage: 'turn' })

    expect(k.verifyBlock).toBe('')
    expect(k.wireInjectionText).toBe('场景：门厅（s1）\n\n## 原文片段（检索补充·仅作描写素材）\n纹理块（桩）')
  })

  it('索引清单抛错：剧本名回退空串（提示词省略「## 故事:」行）', async () => {
    vi.mocked(listStories).mockImplementationOnce(() => {
      throw new Error('index gone')
    })
    const k = await assembleTurnKnowledge({ ...baseInput, workflow: 'rag', playerText: '【艾丽丝】在吗', stage: 'turn' })
    expect(k.storyName).toBe('')
  })
})

describe('assembleTurnKnowledge — trace JSONL 落盘（实验追踪，默认关）', () => {
  it('PREFETCH_TRACE / SUPPLEMENT_TRACE 指向文件时逐行 JSONL（at/roomId/storyId + 事件字段）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-knowledge-trace-'))
    const prefetchTrace = path.join(dir, 'nested', 'prefetch.jsonl')
    const supplementTrace = path.join(dir, 'supplement.jsonl')
    vi.stubEnv('PREFETCH_TRACE', prefetchTrace)
    vi.stubEnv('SUPPLEMENT_TRACE', supplementTrace)

    await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】钥匙在哪', stage: 'turn' })

    const prefetchLines = (await fs.readFile(prefetchTrace, 'utf8')).trim().split('\n')
    expect(prefetchLines.length).toBeGreaterThan(0)
    const prefetchEvent = JSON.parse(prefetchLines[0]!) as { at: number; roomId: string; storyId: string; type: string }
    expect(prefetchEvent.roomId).toBe('room_k')
    expect(prefetchEvent.storyId).toBe('story_k')
    expect(prefetchEvent.type).toBe('prefetch-decision')
    expect(typeof prefetchEvent.at).toBe('number')

    const supplementLines = (await fs.readFile(supplementTrace, 'utf8')).trim().split('\n')
    const supplementEvent = JSON.parse(supplementLines[0]!) as { roomId: string; type: string }
    expect(supplementEvent.roomId).toBe('room_k')
    expect(supplementEvent.type).toBe('supplement-done')
  })

  it('未设置 trace 环境变量：零文件写入（默认关）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-knowledge-notrace-'))
    await assembleTurnKnowledge({ ...baseInput, workflow: 'dossier', playerText: '【艾丽丝】钥匙在哪', stage: 'turn' })
    const entries = await fs.readdir(dir)
    expect(entries).toEqual([])
  })
})

describe('buildStoryLookup — 查证工具供给决策（workflow 门；执行器本体在档案域）', () => {
  it('rag workflow → undefined（本回合不提供查证工具）', () => {
    expect(buildStoryLookup({ roomId: 'room_k', getWorkflow: () => 'rag', getOwnerId: () => 7, getStoryId: () => 'story_k', getScene: () => null })).toBeUndefined()
  })

  it('dossier workflow → 返回执行器（活值 getter 透传；四工具行为直测在 rag/dossier/__tests__/dossierLookupTools.spec.ts）', () => {
    const lookup = buildStoryLookup({ roomId: 'room_k', getWorkflow: () => 'dossier', getOwnerId: () => 7, getStoryId: () => 'story_k', getScene: () => '门厅' })
    expect(typeof lookup).toBe('function')
  })
})
