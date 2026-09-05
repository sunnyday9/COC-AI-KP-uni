/**
 * T1 wire 采样落库测试（spec #36 / #37）—— kpTurnService.runKpTurn 收口层。
 *
 * 图执行/LLM 全部 vi.mock 桩（不触真实模型）；node:sqlite 走 per-worker 临时
 * DATA_DIR（server/test/setup.ts）。覆盖票 #37 验收：
 *  - 落库字段完整性：wire 序列（初始消息含 RAG 注入 / assistant tool_calls 原始参数 /
 *    tool 结果回填线上同形态 / 最终叙事）+ 同房间 turn_seq 递增；
 *  - 不完整回合不落库（图中断 / 空叙事兜底）；
 *  - KP_WIRE_SAMPLING=0 与 MOCK_AI=1 时零额外写入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agent/kpGraph.js', () => ({
  // kpAgentService（保留真实实现，normalizeMessages 复用）顶层引用这两个运行时值
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
}))

import { invokeKPAgent } from '../../agent/kpGraph.js'
import { runKpTurn, type KpTurnDeps, type KpTurnHandlers, type TurnCharacterMutators } from '../kpTurnService.js'
import { listWireSamplesForRoom } from '../wireSampleService.js'

const invokeKPAgentMock = vi.mocked(invokeKPAgent)

const noop = () => undefined

function makeMutators(): TurnCharacterMutators {
  return {
    updateCharacterHP: noop,
    updateCharacterMP: noop,
    updateCharacterSAN: noop,
    updateCharacterLuck: noop,
    addCharacterDailySanLoss: noop,
    resetCharacterDailySanLoss: noop,
    updateCharacterInsanityState: noop,
    setCharacterMajorWound: noop,
    setCharacterDying: noop,
    growCharacterSkill: noop,
    increaseCthulhuMythos: noop,
    transitionToScene: noop,
    addClue: noop,
    endGame: noop,
    generateId: () => `t_${Math.random().toString(36).slice(2, 8)}`,
  }
}

function makeHandlers(): KpTurnHandlers {
  return {
    onChunk: vi.fn(),
    onToolExecuted: vi.fn(),
    onEnd: vi.fn(),
    onError: vi.fn(),
  }
}

function makeTurnDeps(roomId: string, overrides: Partial<KpTurnDeps> = {}): KpTurnDeps {
  return {
    characters: null,
    activeCharacterId: null,
    mutatorFactory: () => makeMutators(),
    handlers: makeHandlers(),
    sampling: { roomId, storyId: 'story_w1', ragContext: '【RAG 检索】场景：旧图书馆——地下室的门后有刮擦声。' },
    ...overrides,
  }
}

const WIRE_MESSAGES = [
  { role: 'system', content: 'BASE_INSTRUCTIONS 占位\n## 故事情报\n【RAG 检索】场景：旧图书馆——地下室的门后有刮擦声。' },
  { role: 'user', content: '【alice】我调查书架。' },
]

describe('runKpTurn wire 采样（T1）', () => {
  beforeEach(() => {
    invokeKPAgentMock.mockReset()
    invokeKPAgentMock.mockResolvedValue({ content: '最终叙事回复。', toolCalls: [] })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('单轮工具链：落库完整 wire 序列（初始消息含 RAG 注入 / assistant tool_calls 原始参数 / tool 回填 / 最终叙事）', async () => {
    invokeKPAgentMock
      .mockResolvedValueOnce({
        content: '你推开图书馆的门。',
        toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: '{"sides":100}' }],
      })
      .mockResolvedValueOnce({ content: '骰子落下。', toolCalls: [] })

    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_1'))

    const rows = listWireSamplesForRoom('room_wire_1')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.room_id).toBe('room_wire_1')
    expect(row.owner_id).toBe(7)
    expect(row.story_id).toBe('story_w1')
    expect(row.turn_seq).toBe(1)
    expect(row.rag_context).toContain('刮擦声')
    // 原始 assistant tool_calls（含参数 JSON 原样）
    expect(JSON.parse(row.tool_calls)).toEqual([{ id: 'call_1', name: 'roll_dice', arguments: '{"sides":100}' }])

    const wire = JSON.parse(row.wire_messages) as { role: string; content?: string; tool_calls?: unknown[] }[]
    expect(wire).toHaveLength(5)
    // 初始消息原样保留（RAG 注入文本在 wire 中可还原）
    expect(wire[0]).toMatchObject({ role: 'system', content: WIRE_MESSAGES[0]!.content })
    expect(wire[1]).toMatchObject({ role: 'user', content: '【alice】我调查书架。' })
    // assistant tool_calls（OpenAI wire 形态）
    expect(wire[2]).toMatchObject({ role: 'assistant', content: '你推开图书馆的门。' })
    expect(wire[2]!.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'roll_dice', arguments: '{"sides":100}' } },
    ])
    // 工具结果回填 = 线上同形态（摘要头 + 结果 JSON）
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    const toolContent = String(wire[3]!.content)
    expect(toolContent.startsWith('【结果摘要】')).toBe(true)
    expect(toolContent).toContain('"sides":100')
    // 最终叙事回复 = onEnd 交付的完整叙事
    expect(wire[4]).toEqual({ role: 'assistant', content: '你推开图书馆的门。\n\n骰子落下。' })
  })

  it('多轮工具链：每轮 assistant+tool 依序入 wire，tool_calls 聚合原始参数', async () => {
    invokeKPAgentMock
      .mockResolvedValueOnce({ content: '第一段。', toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: '{"sides":100}' }] })
      .mockResolvedValueOnce({ content: '第二段。', toolCalls: [{ id: 'c2', name: 'roll_dice', arguments: '{"sides":6}' }] })
      .mockResolvedValueOnce({ content: '最终叙事。', toolCalls: [] })

    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_multi'))

    const row = listWireSamplesForRoom('room_wire_multi')[0]!
    expect(JSON.parse(row.tool_calls)).toEqual([
      { id: 'c1', name: 'roll_dice', arguments: '{"sides":100}' },
      { id: 'c2', name: 'roll_dice', arguments: '{"sides":6}' },
    ])
    const wire = JSON.parse(row.wire_messages) as { role: string; tool_calls?: unknown[] }[]
    // [system, user, a1, tool1, a2, tool2, final]
    expect(wire).toHaveLength(7)
    expect(wire[2]!.role).toBe('assistant')
    expect(wire[3]!.role).toBe('tool')
    expect(wire[4]!.role).toBe('assistant')
    expect((wire[4]!.tool_calls as { function: { name: string } }[])[0]!.function.name).toBe('roll_dice')
    expect(wire[5]!.role).toBe('tool')
    expect(wire[6]).toEqual({ role: 'assistant', content: '第一段。\n\n第二段。\n\n最终叙事。' })
  })

  it('同房间多回合 turn_seq 单调递增', async () => {
    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_seq'))
    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_seq'))

    const rows = listWireSamplesForRoom('room_wire_seq')
    expect(rows.map((r) => r.turn_seq)).toEqual([1, 2])
  })

  it('图中断回合不落库（中断/兜底文案不进 SFT 语料）', async () => {
    invokeKPAgentMock
      .mockResolvedValueOnce({ content: '开场叙事。', toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: '{"sides":100}' }] })
      .mockRejectedValueOnce(new Error('graph boom'))

    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_fail'))

    expect(listWireSamplesForRoom('room_wire_fail')).toHaveLength(0)
  })

  it('无最终叙事（空回复走兜底文案）不落库', async () => {
    invokeKPAgentMock.mockResolvedValue({ content: '', toolCalls: [] })

    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_empty'))

    expect(listWireSamplesForRoom('room_wire_empty')).toHaveLength(0)
  })

  it('KP_WIRE_SAMPLING=0：成功回合零额外写入，回合行为不变', async () => {
    vi.stubEnv('KP_WIRE_SAMPLING', '0')

    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_off'))

    expect(listWireSamplesForRoom('room_wire_off')).toHaveLength(0)
  })

  it('MOCK_AI=1：确定性脚本回合不采样（零额外写入）', async () => {
    vi.stubEnv('MOCK_AI', '1')

    await runKpTurn(7, { messages: WIRE_MESSAGES }, makeTurnDeps('room_wire_mock'))

    expect(listWireSamplesForRoom('room_wire_mock')).toHaveLength(0)
  })
})
