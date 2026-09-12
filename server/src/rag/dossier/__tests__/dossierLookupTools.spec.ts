/**
 * DossierLookupTools 直测（架构走查候选 3）：档案域查证工具执行器工厂。
 *
 * 四个查证工具（scene_list / scene_dossier / lexical_search / verify_original）的
 * 执行语义此前住在房间域（RoomService 闭包 → 候选 1 收编进 turnKnowledge），但
 * 它们的回包文案与数据源全在档案域——本 spec 直测档案域工厂 buildStoryLookup：
 * 注入假 loadDossier / verifyOriginal（vi.mock 轻核三模块），断言四工具行为、
 * 活值 getter（transition_to_scene 后同回合 verify_original 拿到新场景）与失败降级。
 * 回包文本在此逐字节固化（dossier.journey 与 kpWireSampleRoom 都在断言它）。
 * 「回合内要不要提供查证工具」的 workflow 门决策断言留在 turnKnowledge.spec。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../dossierCore.js', () => ({
  loadDossier: vi.fn(async () => ({
    scriptId: 'story_k',
    storyName: '雾中镇',
    generatedAt: 1,
    scenes: [{ id: 's1', name: '门厅', sceneText: '门厅的铜灯。', description: '', npcIds: [], clueIds: [], requiredClues: [], hooks: [] }],
    clues: [],
    npcs: [],
  })),
  listScenes: vi.fn(() => [{ id: 's1', name: '门厅', description: '一进门的地方' }]),
  buildSceneBlock: vi.fn((_d: unknown, id: string) => `场景：门厅（${id}）`),
  findScene: vi.fn(() => ({ id: 's1', name: '门厅' })),
  renderSceneNotFound: vi.fn((name: string) => `error: scene not found: ${name}`),
  renderLexicalMiss: vi.fn((query: string) => `未检索到与「${query}」相关的条目。`),
  lexicalSearch: vi.fn(() => []),
}))
vi.mock('../coverageGaps.js', () => ({
  loadGaps: vi.fn(async () => null),
  computeSceneCoverage: vi.fn(() => null),
}))
vi.mock('../originalLookup.js', () => ({
  verifyOriginal: vi.fn(async () => ({ content: '查证内容（桩）', meta: { tier: 'scene', chars: 10, ok: true, durationMs: 1 } })),
}))

import { buildStoryLookup, type StoryLookupInput } from '../dossierLookupTools.js'
import { loadDossier, listScenes, buildSceneBlock, findScene, lexicalSearch, renderSceneNotFound, renderLexicalMiss } from '../dossierCore.js'
import { loadGaps, computeSceneCoverage } from '../coverageGaps.js'
import { verifyOriginal } from '../originalLookup.js'

/** 活值 getter 桩：scene 可变——模拟同回合内 transition_to_scene。 */
function makeInput(overrides: Partial<StoryLookupInput> = {}) {
  let scene: string | null = '门厅'
  const input: StoryLookupInput = {
    roomId: 'room_k',
    getWorkflow: () => 'dossier',
    getOwnerId: () => 7,
    getStoryId: () => 'story_k',
    getScene: () => scene,
    ...overrides,
  }
  return { input, setScene: (s: string | null) => (scene = s) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildStoryLookup — 工厂门（dossier workflow 才有查证工具）', () => {
  it('rag workflow → undefined；未绑剧本 → undefined；dossier → 执行器', () => {
    expect(buildStoryLookup(makeInput({ getWorkflow: () => 'rag' }).input)).toBeUndefined()
    expect(buildStoryLookup(makeInput({ getStoryId: () => null }).input)).toBeUndefined()
    expect(typeof buildStoryLookup(makeInput().input)).toBe('function')
  })
})

describe('buildStoryLookup — scene_list / scene_dossier（档案查询）', () => {
  it('scene_list：场景清单（名称 + 一句话简介）；空档案 → 暂无场景', async () => {
    const lookup = buildStoryLookup(makeInput().input)!
    expect(await lookup('scene_list', {})).toEqual({ content: '- 门厅：一进门的地方' })

    vi.mocked(listScenes).mockReturnValueOnce([])
    expect(await lookup('scene_list', {})).toEqual({ content: '剧本档案中暂无场景。' })
  })

  it('scene_dossier：命中 → 场景块附覆盖提示（loadGaps/computeSceneCoverage 同链）', async () => {
    const lookup = buildStoryLookup(makeInput().input)!
    const res = await lookup('scene_dossier', { sceneName: '门厅' })

    expect(findScene).toHaveBeenCalledWith(expect.anything(), '门厅')
    expect(loadGaps).toHaveBeenCalledWith(7, 'story_k')
    expect(buildSceneBlock).toHaveBeenCalledWith(expect.anything(), 's1', null)
    expect(res).toEqual({ content: '场景：门厅（s1）' })
  })

  it('scene_dossier：确有缺口时覆盖率随块回传（gaps → computeSceneCoverage）', async () => {
    const gaps = { gapsVersion: 1 } as never
    const coverage = { coveragePct: 71, gapCount: 2 } as never
    vi.mocked(loadGaps).mockResolvedValueOnce(gaps)
    vi.mocked(computeSceneCoverage).mockReturnValueOnce(coverage)
    const lookup = buildStoryLookup(makeInput().input)!
    const res = await lookup('scene_dossier', { sceneName: '门厅' })

    expect(computeSceneCoverage).toHaveBeenCalledWith(gaps, 's1')
    expect(buildSceneBlock).toHaveBeenCalledWith(expect.anything(), 's1', coverage)
    expect(res).toEqual({ content: '场景：门厅（s1）' })
  })

  it('scene_dossier：未命中 → renderSceneNotFound（回包文案逐字节）；缺参 → error', async () => {
    const lookup = buildStoryLookup(makeInput().input)!
    vi.mocked(findScene).mockReturnValueOnce(null)
    expect(await lookup('scene_dossier', { sceneName: '废墟' })).toEqual({ content: 'error: scene not found: 废墟' })
    expect(renderSceneNotFound).toHaveBeenCalledWith('废墟', ['门厅'])

    expect(await lookup('scene_dossier', {})).toEqual({ content: 'error: sceneName required' })
    expect(await lookup('scene_dossier', { sceneName: '   ' })).toEqual({ content: 'error: sceneName required' })
  })
})

describe('buildStoryLookup — lexical_search（词面检索）', () => {
  it('命中 → [kind] name：text（截 200）格式；落空 → renderLexicalMiss', async () => {
    const lookup = buildStoryLookup(makeInput().input)!

    vi.mocked(lexicalSearch).mockReturnValueOnce([{ kind: 'clue', name: '铜钥匙', text: '一把黄铜钥匙，齿痕新鲜。', score: 3 }])
    expect(await lookup('lexical_search', { query: '钥匙' })).toEqual({ content: '[clue] 铜钥匙：一把黄铜钥匙，齿痕新鲜。' })
    expect(lexicalSearch).toHaveBeenCalledWith(expect.anything(), '钥匙', 5)

    vi.mocked(lexicalSearch).mockReturnValueOnce([])
    expect(await lookup('lexical_search', { query: '铜钥匙' })).toEqual({ content: '未检索到与「铜钥匙」相关的条目。' })
    expect(renderLexicalMiss).toHaveBeenCalledWith('铜钥匙')
  })

  it('缺参 → error 回包（不触检索）', async () => {
    const lookup = buildStoryLookup(makeInput().input)!
    expect(await lookup('lexical_search', {})).toEqual({ content: 'error: query required' })
    expect(await lookup('lexical_search', { query: '' })).toEqual({ content: 'error: query required' })
    expect(lexicalSearch).not.toHaveBeenCalled()
  })
})

describe('buildStoryLookup — verify_original（原文查证，活值 getter）', () => {
  it('缺省场景取 getScene() 活值；显式 scene 参数（trim 后）优先；getScene null → undefined', async () => {
    const lookup = buildStoryLookup(makeInput().input)!

    expect(await lookup('verify_original', { question: '铜钥匙在哪' })).toEqual({ content: '查证内容（桩）' })
    expect(verifyOriginal).toHaveBeenCalledWith({ question: '铜钥匙在哪', scene: '门厅' }, { userId: 7, scriptId: 'story_k' })

    await lookup('verify_original', { question: '钟楼的门', scene: ' 钟楼 ' })
    expect(verifyOriginal).toHaveBeenLastCalledWith({ question: '钟楼的门', scene: '钟楼' }, { userId: 7, scriptId: 'story_k' })

    const { input } = makeInput({ getScene: () => null })
    await buildStoryLookup(input)!('verify_original', { question: '全篇哪里提到海' })
    expect(verifyOriginal).toHaveBeenLastCalledWith({ question: '全篇哪里提到海', scene: undefined }, { userId: 7, scriptId: 'story_k' })
  })

  it('活值 getter：同回合内场景切换（transition_to_scene）后，verify_original 拿到新场景', async () => {
    const { input, setScene } = makeInput()
    const lookup = buildStoryLookup(input)!

    await lookup('verify_original', { question: '铜钥匙在哪' })
    expect(verifyOriginal).toHaveBeenLastCalledWith({ question: '铜钥匙在哪', scene: '门厅' }, expect.anything())

    setScene('钟楼')
    await lookup('verify_original', { question: '钟楼的门是什么状态' })
    expect(verifyOriginal).toHaveBeenLastCalledWith({ question: '钟楼的门是什么状态', scene: '钟楼' }, { userId: 7, scriptId: 'story_k' })
  })

  it('缺参 → error 回包（不触查证）', async () => {
    const lookup = buildStoryLookup(makeInput().input)!
    expect(await lookup('verify_original', {})).toEqual({ content: 'error: question required' })
    expect(verifyOriginal).not.toHaveBeenCalled()
  })
})

describe('buildStoryLookup — 失败降级（回合不因查证中断）', () => {
  it('档案缺失（loadDossier → null）→ error 回包文本（不抛出）', async () => {
    vi.mocked(loadDossier).mockResolvedValueOnce(null)
    const lookup = buildStoryLookup(makeInput().input)!
    expect(await lookup('scene_list', {})).toEqual({ content: 'error: 剧本档案不存在' })
    expect(listScenes).not.toHaveBeenCalled()
  })

  it('未知工具 → error 回包文本', async () => {
    const lookup = buildStoryLookup(makeInput().input)!
    expect(await lookup('nope', {})).toEqual({ content: 'error: unknown tool "nope"' })
  })

  it('执行器内异常原样上抛（契约钉住）：降级由回包文本与 kpTurnService 的 try/catch 兜底承担', async () => {
    vi.mocked(verifyOriginal).mockRejectedValueOnce(new Error('reader down'))
    const lookup = buildStoryLookup(makeInput().input)!
    await expect(lookup('verify_original', { question: 'q' })).rejects.toThrow('reader down')
  })
})
