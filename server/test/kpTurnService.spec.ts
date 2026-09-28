/**
 * kpTurnService — 服务端图内工具循环（MOCK_AI 确定性链路）。
 * 验证：侦查消息 → skill_check → grant_clue → 「线索已记录」收尾的完整闭环。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { runKpTurn } from '../src/services/kpTurnService.js'
import * as kpGraph from '../src/agent/kpGraph.js'
import { createCharacterMutatorFactory } from '../src/rule-engine/characterMutators.js'
import { loadScriptContext, type ScriptContext } from '../src/agent/scriptContext.js'
import type { COCCharacterSheet } from '../../shared/types/character.js'

const loadScriptContextMock = vi.hoisted(() => vi.fn())
vi.mock('../src/agent/scriptContext.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agent/scriptContext.js')>(),
  loadScriptContext: loadScriptContextMock,
}))

beforeAll(() => {
  process.env.MOCK_AI = '1'
})

// These are deliberate end-to-end graph-loop checks. The first invocation
// includes the real LangGraph/tool machinery and can be slower on a cold
// worker, especially when the full server suite is running in parallel.
const GRAPH_LOOP_TIMEOUT_MS = 60_000

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

function runTurnWithTerminalEndings(
  userText: string,
  terminalEndings: unknown[],
  modelResponses?: Awaited<ReturnType<typeof kpGraph.invokeKPAgent>>[],
) {
  const invokeSpy = vi.spyOn(kpGraph, 'invokeKPAgent')
  for (const response of modelResponses ?? []) invokeSpy.mockResolvedValueOnce(response)
  const executedTools: { name: string; success: boolean }[] = []
  return new Promise<{
    toolCalls: { name: string }[]
    executedTools: { name: string; success: boolean }[]
    llmIterations: number
    worldDeltas: { ending?: { outcome: string; title: string; summary: string } }
  }>((resolve, reject) => {
    void runKpTurn(
      1,
      {
        messages: [
          { role: 'system', content: '你是守秘人。' },
          { role: 'user', content: userText },
        ],
        storyContext: { terminalEndings },
      },
      {
        characters: { default: MOCK_SHEET },
        activeCharacterId: 'default',
        mutatorFactory: createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'default' ? MOCK_SHEET : null) }),
        handlers: {
          onChunk: () => {},
          onToolExecuted: ({ name, success }) => executedTools.push({ name, success }),
          onEnd: (r) => {
            const llmIterations = invokeSpy.mock.calls.length
            invokeSpy.mockRestore()
            resolve({ toolCalls: r.toolCalls, executedTools, llmIterations, worldDeltas: r.worldDeltas })
          },
          onError: (e) => {
            invokeSpy.mockRestore()
            reject(new Error(e))
          },
        },
      },
    )
  })
}

function runStoryConditionTurn(scriptContext: ScriptContext, storyContext: Record<string, unknown>) {
  vi.mocked(loadScriptContext).mockResolvedValue(scriptContext)
  return new Promise<{
    toolCalls: { name: string; arguments: string }[]
    worldDeltas: { cluesAdded: { description: string; clueId?: string }[]; sceneChanged?: string }
  }>((resolve, reject) => {
    void runKpTurn(
      1,
      {
        messages: [
          { role: 'system', content: '你是守秘人。' },
          { role: 'user', content: '我侦查一下书架。' },
        ],
        storyContext,
      },
      {
        characters: { default: MOCK_SHEET },
        activeCharacterId: 'default',
        mutatorFactory: createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'default' ? MOCK_SHEET : null) }),
        handlers: {
          onChunk: () => {},
          onEnd: (r) => resolve({ toolCalls: r.toolCalls, worldDeltas: r.worldDeltas }),
          onError: (e) => reject(new Error(e)),
        },
      },
    )
  })
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
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('server-side enforcement prevents an ambiguous scripted clue from mutating room state', async () => {
    const result = await runStoryConditionTurn({
      scenes: [{ id: 'library', name: '图书馆', clueIds: ['script_key'] }],
      clues: [{ id: 'script_key', description: '书架后的暗格里藏着一把铜钥匙', obtainCondition: '检查完房间后' }],
      npcs: [],
    }, { scriptId: 'ambiguous-story', sceneId: 'library', openClues: [] })

    expect(result.toolCalls.map((call) => call.name)).toContain('grant_clue')
    expect(result.worldDeltas.cluesAdded).toEqual([])
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('a valid scripted clue grant records the canonical clue ID for later conditions', async () => {
    const result = await runStoryConditionTurn({
      scenes: [{ id: 'library', name: '图书馆', clueIds: ['script_key'] }],
      clues: [
        { id: 'note', description: '值班记录' },
        { id: 'script_key', description: '书架后的暗格里藏着一把铜钥匙', obtainCondition: 'requires_clues: note' },
      ],
      npcs: [],
    }, { scriptId: 'valid-story', sceneId: 'library', openClues: ['note'] })

    expect(result.worldDeltas.cluesAdded).toEqual([
      { description: '书架后的暗格里藏着一把铜钥匙', clueId: 'script_key' },
    ])
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('loads story conditions from the persisted story owner while AI calls keep the room owner identity', async () => {
    await runStoryConditionTurn({
      scenes: [{ id: 'library', name: '图书馆', clueIds: [] }],
      clues: [],
      npcs: [],
    }, { scriptId: 'handoff-story', storyOwnerId: 70001, sceneId: 'library', openClues: [] })

    expect(loadScriptContext).toHaveBeenLastCalledWith(70001, 'handoff-story')
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('cancels a dossier turn when its story condition context is unavailable', async () => {
    vi.mocked(loadScriptContext).mockResolvedValue(null)
    const invokeSpy = vi.spyOn(kpGraph, 'invokeKPAgent')
    const onError = vi.fn()
    const onEnd = vi.fn()

    try {
      await runKpTurn(
        1,
        {
          messages: [{ role: 'user', content: '我尝试切换场景并寻找线索。' }],
          storyContext: { scriptId: 'missing-dossier', workflow: 'dossier' },
        },
        {
          characters: { default: MOCK_SHEET },
          activeCharacterId: 'default',
          mutatorFactory: createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'default' ? MOCK_SHEET : null) }),
          handlers: { onChunk: () => {}, onEnd, onError },
        },
      )

      expect(onError).toHaveBeenCalledWith(expect.stringContaining('cancelled'))
      expect(onEnd).not.toHaveBeenCalled()
      expect(invokeSpy).not.toHaveBeenCalled()
    } finally {
      invokeSpy.mockRestore()
    }
  })

  it('discards stale model output and tool calls after ownership changes in flight', async () => {
    let transferred = false
    const invokeSpy = vi.spyOn(kpGraph, 'invokeKPAgent').mockImplementationOnce(async () => {
      transferred = true
      return {
        content: '旧房主回合结果',
        toolCalls: [{ id: 'stale_tool', name: 'grant_clue', arguments: JSON.stringify({ description: '不应写入的线索' }) }],
      } as Awaited<ReturnType<typeof kpGraph.invokeKPAgent>>
    })
    const onOwnerChanged = vi.fn()
    const onEnd = vi.fn()
    const onToolExecuted = vi.fn()

    await runKpTurn(
      1,
      { messages: [{ role: 'user', content: '我检查书架。' }] },
      {
        characters: { default: MOCK_SHEET },
        activeCharacterId: 'default',
        mutatorFactory: createCharacterMutatorFactory({ resolveSheet: (id) => (id === 'default' ? MOCK_SHEET : null) }),
        isOwnerCurrent: () => !transferred,
        onOwnerChanged,
        handlers: { onChunk: () => {}, onToolExecuted, onEnd, onError: () => {} },
      },
    )

    expect(onOwnerChanged).toHaveBeenCalledTimes(1)
    expect(onEnd).not.toHaveBeenCalled()
    expect(onToolExecuted).not.toHaveBeenCalled()
    invokeSpy.mockRestore()
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('档案中的弱完成措辞由服务端直接触发结构化结局', async () => {
    const result = await runTurnWithTerminalEndings('破坏仪式', [
      { name: '仪式被阻止', condition: '破坏仪式', outcome: '祭祀终止，调查员幸存。' },
    ])

    expect(result.toolCalls.map((call) => call.name).filter((name) => name === 'end_game')).toEqual(['end_game'])
    expect(result.executedTools.filter((tool) => tool.name === 'end_game')).toEqual([
      { name: 'end_game', success: true },
    ])
    expect(result.llmIterations).toBe(1)
    expect(result.worldDeltas.ending).toMatchObject({
      outcome: 'victory',
      title: '仪式被阻止',
      summary: '祭祀终止，调查员幸存。',
    })
  }, GRAPH_LOOP_TIMEOUT_MS)

  it.each([
    { userText: '真相大白', ending: { name: '真相结局', condition: '揭开真相', outcome: '幕后真相公开。' }, outcome: 'victory' },
    { userText: '成功逃离', ending: { name: '逃生结局', condition: '成功逃离地底', outcome: '调查员逃出生天。' }, outcome: 'survival' },
    { userText: '团灭', ending: { name: '团灭结局', condition: '调查员团灭', outcome: '所有调查员阵亡。' }, outcome: 'defeat' },
    { userText: '永久疯狂', ending: { name: '永久疯狂结局', condition: '调查员陷入永久疯狂', outcome: '调查员永久失去理智。' }, outcome: 'defeat' },
  ])('结构化终局元数据匹配后强制结局：$userText', async ({ userText, ending, outcome }) => {
    const result = await runTurnWithTerminalEndings(userText, [ending])

    expect(result.worldDeltas.ending).toMatchObject({ outcome, title: ending.name, summary: ending.outcome })
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('没有结构化终局元数据时保留遗留模型 end_game 行为', async () => {
    const result = await runTurnWithTerminalEndings('我们成功逃离了这里', [])

    expect(result.toolCalls.map((call) => call.name).filter((name) => name === 'end_game')).toEqual(['end_game'])
    expect(result.executedTools.filter((tool) => tool.name === 'end_game')).toEqual([
      { name: 'end_game', success: true },
    ])
    expect(result.llmIterations).toBe(1)
    expect(result.worldDeltas.ending).toBeDefined()
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('a malformed legacy end_game can recover before a successful end ends the turn', async () => {
    const result = await runTurnWithTerminalEndings('结束冒险', [], [
      {
        content: 'The ending details are incomplete.',
        toolCalls: [{ id: 'call_bad_end', name: 'end_game', arguments: '{"outcome":"victory","title":"结局"}' }],
      },
      {
        content: 'Recovered ending.',
        toolCalls: [{ id: 'call_valid_end', name: 'end_game', arguments: '{"outcome":"victory","title":"结局","summary":"冒险结束。"}' }],
      },
    ])

    expect(result.executedTools.filter((tool) => tool.name === 'end_game')).toEqual([
      { name: 'end_game', success: false },
      { name: 'end_game', success: true },
    ])
    expect(result.llmIterations).toBe(2)
    expect(result.worldDeltas.ending).toMatchObject({ outcome: 'victory', title: '结局', summary: '冒险结束。' })
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('存在结构化终局元数据但玩家措辞未命中时，抑制模型 end_game', async () => {
    const result = await runTurnWithTerminalEndings('我们成功逃离了这里', [
      { name: '真相结局', condition: '调查员揭开幕后真相', outcome: '幕后真相公开。' },
    ])

    expect(result.toolCalls.map((call) => call.name)).not.toContain('end_game')
    expect(result.worldDeltas.ending).toBeUndefined()
  }, GRAPH_LOOP_TIMEOUT_MS)

  it.each([
    { userText: '我没有破坏仪式', ending: { name: '仪式被阻止', condition: '破坏仪式', outcome: '祭祀终止。' } },
    { userText: '我破坏仪式没成功', ending: { name: '仪式被阻止', condition: '破坏仪式', outcome: '祭祀终止。' } },
    { userText: '我没有成功逃离地底', ending: { name: '逃生结局', condition: '成功逃离地底', outcome: '调查员逃出生天。' } },
    { userText: '我无法成功逃离地底', ending: { name: '逃生结局', condition: '成功逃离地底', outcome: '调查员逃出生天。' } },
  ])('否定完成措辞不能触发结构化终局：$userText', async ({ userText, ending }) => {
    const result = await runTurnWithTerminalEndings(userText, [ending])

    expect(result.toolCalls.map((call) => call.name)).not.toContain('end_game')
    expect(result.worldDeltas.ending).toBeUndefined()
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('玩家仍在计划逃离时，即使措辞命中终局条件也不提前结束', async () => {
    const result = await runTurnWithTerminalEndings('我计划成功逃离地底', [
      { name: '逃生结局', condition: '成功逃离地底', outcome: '调查员逃出生天。' },
    ])

    expect(result.toolCalls.map((call) => call.name)).not.toContain('end_game')
    expect(result.worldDeltas.ending).toBeUndefined()
  }, GRAPH_LOOP_TIMEOUT_MS)

  it.each(['我想知道怎样成功逃离地底需要什么条件？', '如果我们成功逃离地底'])('疑问或假设中的逃离不触发结构化终局：%s', async (userText) => {
    const result = await runTurnWithTerminalEndings(userText, [
      { name: '逃生结局', condition: '成功逃离地底', outcome: '调查员逃出生天。' },
    ])

    expect(result.toolCalls.map((call) => call.name)).not.toContain('end_game')
    expect(result.worldDeltas.ending).toBeUndefined()
  }, GRAPH_LOOP_TIMEOUT_MS)

  it('已完成逃离后在新分句中提问仍触发结构化终局', async () => {
    const result = await runTurnWithTerminalEndings('我成功逃离了地底，接下来该做什么？', [
      { name: '逃生结局', condition: '成功逃离地底', outcome: '调查员逃出生天。' },
    ])

    expect(result.worldDeltas.ending).toMatchObject({ outcome: 'survival', title: '逃生结局' })
  }, GRAPH_LOOP_TIMEOUT_MS)

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
  }, GRAPH_LOOP_TIMEOUT_MS)
})
