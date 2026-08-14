/**
 * 端到端工具调用闭环（Task 10 核心交付）：
 * KP Agent 返回 toolCalls → client orchestrator → handler 执行（真实 handlers）
 * → 角色卡/线索状态更新 → 工具结果拼接进下一轮 messages（runKpAgentLoop 循环语义）。
 *
 * mock 策略（沿用 gameStore.integration.spec.ts 模式，不真连后端）：
 *  - 只 mock platform bridge 的网络边界 `kpInvoke`（返回固定 toolCalls 序列，
 *    等价于「KP Agent 返回工具调用」）+ RAG context 返回空 + user graph/aiChat
 *  - kpSessionService（runKpAgentLoop/kpInvokeOnce）与 gameStore、orchestrator、
 *    handlers 全部为【真实实现】——只有真实循环才能证明
 *    「下一轮 messages 携带上一轮 tool 结果」这一闭环语义
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGameStore } from '../../stores/gameStore'
import { useSettingsStore } from '../../stores/settingsStore'

const { bridge } = vi.hoisted(() => ({
  bridge: {
    kpInvoke: vi.fn(),
    ragContext: vi.fn(),
    ragUserGraphSummary: vi.fn(),
    ragUserGraphAdd: vi.fn(),
    ragUserGraphSync: vi.fn(),
    aiChat: vi.fn(),
    writeSave: vi.fn(),
    readSave: vi.fn(),
    listSaves: vi.fn(),
  },
}))

vi.mock('../../platform/index', () => ({
  getBridge: () => bridge,
}))

vi.mock('../../services/memoryService', () => ({
  summarizeLongTerm: vi.fn().mockResolvedValue('SUMMARY_NEXT'),
}))

type AnyMsg = { role: string; content?: string; tool_call_id?: string; tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] }

function makeSheet(): Record<string, unknown> {
  return {
    playerName: '调查员A',
    occupationName: '记者',
    derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 99 },
    attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
    skills: {},
  }
}

/** flush fire-and-forget microtasks (extractMemoryPoints / summarization). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
}

function startPlaying(): ReturnType<typeof useGameStore> {
  const store = useGameStore()
  store.startGame({ storyId: 'story.md', storyName: '雾中校门' })
  store.setCharacterSheet(makeSheet() as any)
  store.confirmCharacterAndEnterGame()
  return store
}

describe('toolLoop integration (sendPlayerMessage → runKpAgentLoop → handlers → state)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    bridge.kpInvoke.mockReset()
    bridge.ragContext.mockReset().mockResolvedValue({ context: '', chunkCount: 0 }) // RAG context 返回空
    bridge.ragUserGraphSummary.mockReset().mockResolvedValue({ summary: '' })
    bridge.ragUserGraphAdd.mockReset().mockResolvedValue({ ok: true })
    bridge.ragUserGraphSync.mockReset().mockResolvedValue({ ok: true })
    bridge.aiChat.mockReset().mockResolvedValue({ stream: false, content: '["记忆点A"]' })
    bridge.writeSave.mockReset().mockResolvedValue(undefined)
    bridge.readSave.mockReset().mockResolvedValue({})
    bridge.listSaves.mockReset().mockResolvedValue([])

    const settings = useSettingsStore()
    settings.settings.ai.model = 'gpt-4'
    settings.settings.ai.provider = 'openai'
    settings.settings.ai.temperature = 0.7
    settings.settings.ai.maxTokens = 2048
  })

  /** 第 n 轮发给「KP Agent」的 messages（bridge.kpInvoke 参数） */
  function roundMsgs(n: number): AnyMsg[] {
    const call = bridge.kpInvoke.mock.calls[n] as [unknown, ...unknown[]] | undefined
    const params = call?.[0] as { messages?: unknown[] } | undefined
    return (params?.messages ?? []) as unknown as AnyMsg[]
  }

  it('multi-round tool loop: skill_check → roll_dice → grant_clue → adjust_hp, results fed into next-round messages', async () => {
    const store = startPlaying()

    bridge.kpInvoke
      .mockResolvedValueOnce({
        content: '守密人决定检定。',
        toolCalls: [{ id: 'tc1', name: 'skill_check', arguments: JSON.stringify({ skillName: '侦查', skillValue: 50, difficulty: 'regular' }) }],
      })
      .mockResolvedValueOnce({
        content: '守密人掷骰。',
        toolCalls: [{ id: 'tc2', name: 'roll_dice', arguments: JSON.stringify({ sides: 6 }) }],
      })
      .mockResolvedValueOnce({
        content: '守密人注意到暗格。',
        toolCalls: [{ id: 'tc3', name: 'grant_clue', arguments: JSON.stringify({ description: '壁炉后的暗格' }) }],
      })
      .mockResolvedValueOnce({
        content: '守密人记录了伤势。',
        toolCalls: [{ id: 'tc4', name: 'adjust_hp', arguments: JSON.stringify({ delta: -3 }) }],
      })
      .mockResolvedValueOnce({ content: '守密人总结。', toolCalls: undefined })

    await store.sendPlayerMessage('我尝试撬锁')

    // 1) loop: 4 轮工具 + 1 轮结束 = 5 次 LLM 调用
    expect(bridge.kpInvoke).toHaveBeenCalledTimes(5)

    // 2) 闭环语义：第 2 轮起 messages 携带上一轮工具结果（assistant.tool_calls + role=tool 结果）
    const round1Msgs = roundMsgs(0)
    const round2Msgs = roundMsgs(1)
    const round3Msgs = roundMsgs(2)
    const round4Msgs = roundMsgs(3)
    const round5Msgs = roundMsgs(4)

    // 第一轮：无任何 tool 消息
    expect(round1Msgs.some((m) => m.role === 'tool')).toBe(false)

    // 第二轮：携带 skill_check 的 assistant tool_calls + 执行结果（handler 产出）
    const asst1 = round2Msgs.find((m) => m.role === 'assistant' && !!m.tool_calls?.length)
    expect(asst1?.tool_calls?.[0]).toMatchObject({ id: 'tc1' })
    expect(asst1?.tool_calls?.[0]?.function?.name).toBe('skill_check')
    const tool1 = round2Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'tc1')
    expect(tool1).toBeDefined()
    const skillResult = JSON.parse(tool1!.content ?? '{}') as { roll: number; skillName: string; skillValue: number; result: string }
    expect(skillResult.skillName).toBe('侦查')
    expect(skillResult.skillValue).toBe(50)
    expect(skillResult.roll).toBeGreaterThanOrEqual(1)
    expect(skillResult.roll).toBeLessThanOrEqual(100)

    // 第三轮：携带 roll_dice 结果
    const tool2 = round3Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'tc2')
    expect(tool2).toBeDefined()
    const diceResult = JSON.parse(tool2!.content ?? '{}') as { roll: number; sides: number }
    expect(diceResult.sides).toBe(6)
    expect(diceResult.roll).toBeGreaterThanOrEqual(1)
    expect(diceResult.roll).toBeLessThanOrEqual(6)

    // 第四轮：携带 grant_clue 结果
    const tool3 = round4Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'tc3')
    expect(tool3?.content).toContain('壁炉后的暗格')

    // 第五轮：携带 adjust_hp 结果
    const tool4 = round5Msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'tc4')
    expect(tool4?.content).toBe('HP adjusted by -3')

    // 3) 状态更新：线索（grant_clue → addClue）与角色卡（adjust_hp → HP 10-3）
    expect(store.cluesObtained).toContain('壁炉后的暗格')
    expect((store.characterSheet as any).derived.hp).toBe(7)

    // 4) 消息序列：系统展示消息（骰子/线索/HP）在 kp 消息前插入，kp 终态含累积内容
    const kp = store.messages[store.messages.length - 1] as AnyMsg & { isStreaming?: boolean }
    expect(kp.role).toBe('kp')
    expect(kp.content).toContain('守密人决定检定')
    expect(kp.content).toContain('守密人总结')
    expect(kp.isStreaming).toBe(false)
    const systemContents = store.messages.filter((m) => m.role === 'system').map((m) => String((m as AnyMsg).content ?? ''))
    expect(systemContents.some((c) => c.includes('侦查检定'))).toBe(true)
    expect(systemContents.some((c) => c.includes('投骰 d6'))).toBe(true)
    expect(systemContents.some((c) => c.includes('获得线索: 壁炉后的暗格'))).toBe(true)
    expect(systemContents.some((c) => c.includes('HP -3'))).toBe(true)

    // 5) skill_check 经 user graph 事件上报（bridge）
    expect(bridge.ragUserGraphAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: 'story.md',
        event: expect.objectContaining({ type: 'action', name: '技能检定: 侦查' }),
      }),
    )

    // 6) 回合结束：isSending 复位；记忆点经 bridge.aiChat 提取（fire-and-forget，flush 后生效）
    expect(store.isSending).toBe(false)
    await flush()
    expect(store.kpMemory).toEqual(['记忆点A'])
  })

  it('single round without toolCalls: no tool messages appended, loop ends after one call', async () => {
    const store = startPlaying()
    bridge.kpInvoke.mockResolvedValueOnce({ content: '守密人直接回应。', toolCalls: undefined })

    await store.sendPlayerMessage('你好')

    expect(bridge.kpInvoke).toHaveBeenCalledTimes(1)
    expect(roundMsgs(0).some((m) => m.role === 'tool')).toBe(false)

    expect(store.messages).toHaveLength(2) // player + kp
    const kp = store.messages[store.messages.length - 1] as AnyMsg
    expect(kp.content).toContain('守密人直接回应')
    expect(store.cluesObtained).toEqual([])
  })

  it('MAX_TOOL_ITERATIONS guard: tool-only loop stops after 8 iterations', async () => {
    const store = startPlaying()
    // 每轮都返回工具调用 → 真实 runKpAgentLoop 必须在上限处终止（不会死循环）
    bridge.kpInvoke.mockResolvedValue({
      content: '又一轮。',
      toolCalls: [{ id: 'tc', name: 'roll_dice', arguments: JSON.stringify({ sides: 6 }) }],
    })

    await store.sendPlayerMessage('持续行动')

    expect(bridge.kpInvoke).toHaveBeenCalledTimes(8)
    expect(store.isSending).toBe(false)
    const kp = store.messages[store.messages.length - 1] as AnyMsg
    expect(kp.role).toBe('kp')
    expect(kp.content).toContain('又一轮')
  })
})
