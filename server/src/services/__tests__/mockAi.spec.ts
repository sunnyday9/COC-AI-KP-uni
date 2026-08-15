import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, chatForAgent, chatForRag, listModels } from '../aiService.js'
import { invokeKp, invokeKpStream } from '../kpAgentService.js'
import { BadRequestError, UpstreamError } from '../../utils/errors.js'

/**
 * MOCK_AI mode tests (Task 11, Phase 10).
 *
 * Contract under test:
 *  - MOCK_AI=1 short-circuits every AI entry point with a deterministic script
 *    BEFORE settings resolution — no API key / model / baseUrl required.
 *  - The KP LangGraph state machine still runs for real: the mock only answers
 *    the LLM calls (classifier keyword, keyword→toolCalls, continuation chain).
 *  - chat() → fixed content (+ chunks when streaming); listModels() → fixed
 *    option; chatForRag() → fixed parseable output.
 *  - MOCK_AI unset → behavior is bit-identical to baseline (config never read):
 *    chat without settings still raises the settings-required BadRequestError.
 */

const MOCK_ENV: Record<string, string> = {
  MOCK_AI: '1',
  PORT: '3199',
  JWT_SECRET: 'test-secret',
  DATA_DIR: 'mock-ai-test-data',
  RAG_DATA_DIR: 'mock-ai-test-rag',
  UPLOADS_DIR: 'mock-ai-test-uploads',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

function stubMockEnv() {
  for (const [k, v] of Object.entries(MOCK_ENV)) vi.stubEnv(k, v)
}

describe('MOCK_AI=1 — chat (api-contract §3)', () => {
  it('returns fixed content without any settings configured', async () => {
    stubMockEnv()
    const result = await chat(999, { messages: [{ role: 'user', content: '你好' }] })
    expect(result.stream).toBe(false)
    expect(result.content).toContain('（测试模式）')
  })

  it('returns buffered chunks when stream=true', async () => {
    stubMockEnv()
    const result = await chat(999, { messages: [{ role: 'user', content: '你好' }], stream: true })
    expect(result.stream).toBe(true)
    expect(Array.isArray(result.chunks)).toBe(true)
    expect(result.chunks!.join('')).toContain('（测试模式）')
  })

  it('still validates messages before the mock short-circuit', async () => {
    stubMockEnv()
    await expect(chat(999, { messages: [] })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('non-mock path unchanged: no settings → BadRequestError (zero-impact proof)', async () => {
    // MOCK_AI deliberately NOT set
    await expect(chat(1, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(BadRequestError)
  })
})

describe('MOCK_AI=1 — chatForAgent deterministic script', () => {
  it('classifier call returns the keyword-mapped intent word', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: '只回复一个英文意图关键词，例如 narrative 或 investigate。不要解释。' },
        { role: 'user', content: '我发动攻击！' },
      ],
    })
    expect(result.content).toBe('combat')
  })

  it('classifier scans only the player message, not the prompt examples (regression)', async () => {
    stubMockEnv()
    // The real classifier prompt embeds intent examples that contain the
    // trigger keywords (战斗/攻击/射击...) — the mock must classify the text
    // after '玩家消息: ' only.
    const prompt =
      '你是一个 COC 7th 跑团意图分类器。根据玩家最新一条消息，从以下意图中选出最匹配的，只回复一个英文关键词。\n\n' +
      '意图类型:\n- combat: 战斗、攻击、格斗、射击、闪避\n- investigate: 搜索、侦查、检查某物\n\n' +
      '玩家消息: 请开始游戏，向调查员做开场白。'
    const opening = await chatForAgent(999, {
      messages: [
        { role: 'system', content: '只回复一个英文意图关键词，例如 narrative 或 investigate。不要解释。' },
        { role: 'user', content: prompt },
      ],
    })
    expect(opening.content).toBe('narrative')

    const attack = await chatForAgent(999, {
      messages: [
        { role: 'system', content: '只回复一个英文意图关键词，例如 narrative 或 investigate。不要解释。' },
        { role: 'user', content: '玩家消息: 我发动攻击！' },
      ],
    })
    expect(attack.content).toBe('combat')
  })

  it('fresh turn with 侦查 returns skill_check tool call', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: '你是守密人' },
        { role: 'user', content: '我仔细侦查房间，搜索书架。' },
      ],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0].name).toBe('skill_check')
    expect(JSON.parse(result.toolCalls![0].arguments)).toMatchObject({ skillName: '侦查' })
  })

  it('fresh turn with 战斗 returns combat skill_check', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: '你是守密人' },
        { role: 'user', content: '我发起攻击！' },
      ],
    })
    expect(result.toolCalls![0].name).toBe('skill_check')
    expect(JSON.parse(result.toolCalls![0].arguments)).toMatchObject({ skillName: '格斗' })
  })

  it('continuation: combat skill check result → roll_dice', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我发起攻击！' },
        {
          role: 'tool',
          tool_call_id: 'mock_tc_0',
          content: JSON.stringify({ roll: 34, threshold: 60, skillName: '格斗', skillValue: 60, difficulty: 'regular', result: 'regular_success', success: true }),
        },
      ],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0].name).toBe('roll_dice')
  })

  it('continuation: roll_dice result → adjust_hp (-2)', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我发起攻击！' },
        { role: 'tool', tool_call_id: 'tc1', content: JSON.stringify({ roll: 5, sides: 6 }) },
      ],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0].name).toBe('adjust_hp')
    expect(JSON.parse(result.toolCalls![0].arguments)).toMatchObject({ delta: -2 })
  })

  it('continuation: non-combat skill check result → grant_clue', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我仔细侦查房间，搜索书架。' },
        {
          role: 'tool',
          tool_call_id: 'mock_tc_0',
          content: JSON.stringify({ roll: 24, threshold: 65, skillName: '侦查', skillValue: 65, difficulty: 'regular', result: 'hard_success', success: true }),
        },
      ],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0].name).toBe('grant_clue')
    expect(JSON.parse(result.toolCalls![0].arguments)).toMatchObject({ description: expect.stringContaining('铜钥匙') })
  })

  it('continuation: grant_clue result → narrative conclusion', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我仔细侦查房间，搜索书架。' },
        { role: 'tool', tool_call_id: 'tc1', content: JSON.stringify({ success: true, description: '书架后的暗格里藏着一把铜钥匙' }) },
      ],
    })
    expect(result.toolCalls).toBeUndefined()
    expect(result.content).toContain('获得了线索')
  })

  it('continuation: HP-adjusted result → narrative conclusion', async () => {
    stubMockEnv()
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我发起攻击！' },
        { role: 'tool', tool_call_id: 'tc2', content: 'HP adjusted by -2' },
      ],
    })
    expect(result.toolCalls).toBeUndefined()
    expect(result.content).toContain('（测试模式）')
  })

  it('streaming emits chunks through onChunk', async () => {
    stubMockEnv()
    const chunks: string[] = []
    const result = await chatForAgent(999, {
      messages: [
        { role: 'system', content: '你是守密人' },
        { role: 'user', content: '今天天气不错' },
      ],
      stream: true,
      onChunk: (c) => chunks.push(c),
    })
    expect(result.content).toContain('（测试模式）')
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join('')).toBe(result.content)
  })
})

describe('MOCK_AI=1 — chatForRag / listModels', () => {
  it('chatForRag returns fixed parseable content', async () => {
    stubMockEnv()
    const result = await chatForRag(999, { messages: [{ role: 'user', content: 'extract' }] })
    expect(result.content).toBe('（测试模式）')
  })

  it('listModels returns the fixed mock option', async () => {
    stubMockEnv()
    const result = await listModels(999)
    expect(result).toEqual([{ value: 'mock-model', label: 'mock-model (E2E 测试)' }])
  })
})

describe('MOCK_AI=1 — real kpGraph driven by the mock LLM (kpAgentService)', () => {
  it('REST invoke runs the real state machine and returns toolCalls', async () => {
    stubMockEnv()
    const result = await invokeKp(999, {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我发动攻击！' },
      ],
    })
    expect(result.toolCalls).toBeDefined()
    expect(result.toolCalls![0].name).toBe('skill_check')
    const args = JSON.parse(result.toolCalls![0].arguments) as { skillName: string }
    expect(args.skillName).toBe('格斗')
  })

  it('WS stream path emits chunk → trace → end with mock toolCalls', async () => {
    stubMockEnv()
    const events: { kind: string; payload: unknown }[] = []
    await invokeKpStream(
      999,
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '我仔细侦查房间，搜索书架。' },
        ],
      },
      {
        onChunk: (chunk) => events.push({ kind: 'chunk', payload: chunk }),
        onTrace: (traceEvents) => events.push({ kind: 'trace', payload: traceEvents }),
        onEnd: (result) => events.push({ kind: 'end', payload: result }),
        onError: (error) => events.push({ kind: 'error', payload: error }),
      },
    )
    expect(events.map((e) => e.kind)).toContain('end')
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    const end = events.find((e) => e.kind === 'end')!.payload as { content: string; toolCalls?: { name: string }[] }
    expect(end.toolCalls?.[0].name).toBe('skill_check')
  })

  it('non-mock path unchanged: invokeKp without settings fails (zero-impact proof)', async () => {
    // MOCK_AI deliberately NOT set; a bare user with no AI settings fails at
    // resolveAiConfig inside the graph, surfaced as UpstreamError (same path
    // as any other graph LLM failure — baseline behavior).
    await expect(
      invokeKp(1, {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '你好' },
        ],
      }),
    ).rejects.toBeInstanceOf(UpstreamError)
  })
})
