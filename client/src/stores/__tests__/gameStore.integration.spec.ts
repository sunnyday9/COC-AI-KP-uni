import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGameStore } from '../gameStore'
import { useSettingsStore } from '../settingsStore'
import { runKpTurn, hasKpAgent, runDirectChat } from '../../services/kpSessionService'

/**
 * gameStore 集成测试（简报决策 3/8）：mock bridge（platform/index）+
 * mock kpSessionService，验证 sendPlayerMessage 端到端流程：
 * RAG context → kpPromptService → runKpTurn（服务端图内循环，返回
 * content + toolCalls + displayMessages）→ 状态更新（kpMemory/clues/
 * streaming/longTermSummary），以及存档 write/read 往返。不真连后端。
 */
const { bridge } = vi.hoisted(() => ({
  bridge: {
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

vi.mock('../../services/kpSessionService', () => ({
  hasKpAgent: vi.fn(),
  runKpTurn: vi.fn(),
  runDirectChat: vi.fn(),
}))

vi.mock('../../services/memoryService', () => ({
  summarizeLongTerm: vi.fn().mockResolvedValue('SUMMARY_NEXT'),
}))

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

describe('gameStore integration (sendPlayerMessage)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    bridge.ragContext.mockReset().mockResolvedValue({ context: 'RAG_BLOCK', chunkCount: 2 })
    bridge.ragUserGraphSummary.mockReset().mockResolvedValue({ summary: '调查员到达了图书馆' })
    bridge.ragUserGraphAdd.mockReset().mockResolvedValue({ ok: true })
    bridge.ragUserGraphSync.mockReset().mockResolvedValue({ ok: true })
    bridge.aiChat.mockReset().mockResolvedValue({ stream: false, content: '["记忆点A","记忆点B"]' })
    bridge.writeSave.mockReset().mockResolvedValue(undefined)
    bridge.readSave.mockReset().mockResolvedValue({})
    bridge.listSaves.mockReset().mockResolvedValue([])
    vi.mocked(hasKpAgent).mockReturnValue(true)
    vi.mocked(runKpTurn).mockReset()
    vi.mocked(runDirectChat).mockReset()

    const settings = useSettingsStore()
    settings.settings.ai.model = 'gpt-4'
    settings.settings.ai.provider = 'openai'
    settings.settings.ai.temperature = 0.7
    settings.settings.ai.maxTokens = 2048
  })

  function startPlaying(): ReturnType<typeof useGameStore> {
    const store = useGameStore()
    store.startGame({ storyId: 'story.md', storyName: '雾中校门' })
    store.setCharacterSheet(makeSheet() as any)
    store.confirmCharacterAndEnterGame()
    return store
  }

  it('sendPlayerMessage end-to-end: RAG → KP agent loop → toolCalls → orchestrator → state updates', async () => {
    const store = startPlaying()

    vi.mocked(runKpTurn).mockImplementation(async (_msgs, _storyContext, _sheet, callbacks) => {
      // simulate streaming chunk
      callbacks.onStreamChunk('守密人仔细观察')
      // 服务端执行工具：回传 displayMessages（骰子/系统提示）与执行过的工具调用
      const displayMessages = [
        { id: 'd1', timestamp: Date.now(), role: 'system', content: '获得线索: 奇怪的符号' },
      ]
      callbacks.onDisplayMessages?.(displayMessages)
      callbacks.onCharacterSheetUpdate?.({ derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 99 } })
      // 服务端工具执行产生的世界增量（grant_clue → cluesAdded）
      callbacks.onWorldDeltas?.({ cluesAdded: [{ description: '奇怪的符号', clueId: 'c1' }] })
      // real runKpTurn delivers the final content via onStreamChunk
      const final = '守密人发现了线索。'
      callbacks.onStreamChunk(final)
      return { content: final, displayMessages, toolCalls: [{ id: 't1', name: 'grant_clue', arguments: JSON.stringify({ description: '奇怪的符号' }) }], worldDeltas: { cluesAdded: [{ description: '奇怪的符号', clueId: 'c1' }] }, characterSheet: null }
    })

    await store.sendPlayerMessage('我去调查那扇门')

    // RAG context fetched via bridge (storyId + sessionId set)
    expect(bridge.ragContext).toHaveBeenCalledWith({
      query: '我去调查那扇门',
      scriptId: 'story.md',
      sceneId: undefined,
      topK: 8,
    })
    expect(bridge.ragUserGraphSummary).toHaveBeenCalledWith({
      storyId: 'story.md',
      sessionId: store.sessionId,
    })

    // messages: [player, system(获得线索), kp] — display message inserted before last
    expect(store.messages.length).toBe(3)
    const last = store.messages[store.messages.length - 1] as { role: string; content: string; isStreaming?: boolean }
    expect(last.role).toBe('kp')
    expect(last.content).toContain('守密人发现了线索')
    expect(last.isStreaming).toBe(false)
    const system = store.messages[1] as { role: string; content: string }
    expect(system.role).toBe('system')
    expect(system.content).toContain('获得线索: 奇怪的符号')

    // orchestrator executed grant_clue → addClue (structured {id, description})
    expect(store.cluesObtained.some((c) => c.description === '奇怪的符号')).toBe(true)
    // user graph event pushed for the clue
    expect(bridge.ragUserGraphAdd).toHaveBeenCalledWith({
      storyId: 'story.md',
      sessionId: store.sessionId,
      event: { type: 'clue', name: '奇怪的符号' },
    })

    // turn state（playerTurnCount / narrativeStall 均不在 store 公开 API —— 原代码未导出，属原 bug，见任务报告）
    expect(store.isSending).toBe(false)

    // kpMemory: truncated entry replaced by extracted points (bridge.aiChat)
    await flush()
    expect(store.kpMemory).toEqual(['记忆点A', '记忆点B'])
    expect(bridge.aiChat).toHaveBeenCalled()

    // high-impact tool (grant_clue) triggered long-term summarization
    expect(store.longTermSummary).toBe('SUMMARY_NEXT')
  })

  it('falls back to runDirectChat when no KP agent is available', async () => {
    const store = startPlaying()
    vi.mocked(hasKpAgent).mockReturnValue(false)
    vi.mocked(runDirectChat).mockImplementation(async (_msgs, _aiConfig, callbacks) => {
      // real runDirectChat accumulates chunks and delivers the full content
      callbacks.onStreamChunk('直连回复')
      callbacks.onStreamChunk('直连回复完整')
      return '直连回复完整'
    })

    await store.sendPlayerMessage('你好')

    expect(runDirectChat).toHaveBeenCalledTimes(1)
    expect(runKpTurn).not.toHaveBeenCalled()
    const last = store.messages[store.messages.length - 1] as { role: string; content: string; isStreaming?: boolean }
    expect(last.content).toContain('直连回复完整')
    expect(last.isStreaming).toBe(false)
  })

  it('rejects the turn gracefully when no AI model is configured', async () => {
    const store = startPlaying()
    useSettingsStore().settings.ai.model = ''

    await store.sendPlayerMessage('行动')

    const last = store.messages[store.messages.length - 1] as { role: string; content: string; isStreaming?: boolean }
    expect(last.content).toContain('[错误:')
    expect(last.isStreaming).toBe(false)
    expect(store.isSending).toBe(false)
    expect(runKpTurn).not.toHaveBeenCalled()
  })
})

describe('gameStore saves roundtrip (bridge listSaves/writeSave/readSave)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    bridge.writeSave.mockReset().mockResolvedValue(undefined)
    bridge.readSave.mockReset().mockResolvedValue({})
    bridge.listSaves.mockReset().mockResolvedValue(['s1', 's2'])
    bridge.ragUserGraphSync.mockReset().mockResolvedValue({ ok: true })
  })

  it('saveGame writes a versioned snapshot; loadGame restores state', async () => {
    const store = useGameStore()
    store.startGame({ storyId: 'story.md', storyName: '雾中校门' })
    store.addClue('线索A')
    store.longTermSummary = 'LT' as any
    store.kpMemory = ['k1'] as any

    await store.saveGame('s1', '存档1')
    expect(bridge.writeSave).toHaveBeenCalledTimes(1)
    const [saveId, payload] = bridge.writeSave.mock.calls[0] as [string, Record<string, unknown>]
    expect(saveId).toBe('s1')
    expect(payload.version).toBe(1)
    expect(payload.name).toBe('存档1')
    expect(payload.storyId).toBe('story.md')
    expect(payload.cluesObtained).toEqual([{ id: '', description: '线索A' }])
    expect(payload.longTermSummary).toBe('LT')
    expect(payload.kpMemory).toEqual(['k1'])

    bridge.readSave.mockResolvedValue({
      version: 1,
      name: '存档1',
      storyId: 'story.md',
      storyName: '雾中校门',
      storyOverview: '',
      currentScene: '图书馆',
      cluesObtained: ['c1'],
      messages: [{ id: 'm1', timestamp: 1, role: 'kp', content: '欢迎' }],
      kpMemory: ['k2'],
      longTermSummary: 'LT2',
      longTermFacts: ['f1'],
      playerTurnCount: 11,
      gamePhase: 'playing',
      characterSheet: null,
      playerName: '调查员',
      selectedOccupationId: null,
      selectedOccupationName: '',
      sessionId: 'sess1',
    })

    await store.loadGame('s1')
    expect(store.currentScene).toBe('图书馆')
    expect(store.cluesObtained).toEqual([{ id: '', description: 'c1' }])
    expect(store.kpMemory).toEqual(['k2'])
    expect(store.longTermSummary).toBe('LT2')
    expect(store.isInGame).toBe(true)
    // loadGame with storyId+sessionId syncs the user graph
    expect(bridge.ragUserGraphSync).toHaveBeenCalled()

    await expect(store.listSaves()).resolves.toEqual(['s1', 's2'])
  })

  it('loadGame resets long-term fields when the save version mismatches', async () => {
    const store = useGameStore()
    bridge.readSave.mockResolvedValue({
      version: 0,
      name: 'old',
      storyId: 's',
      storyName: 'sn',
      storyOverview: '',
      currentScene: '',
      cluesObtained: [],
      messages: [],
      kpMemory: [],
      longTermSummary: 'STALE',
      longTermFacts: ['stale'],
      playerTurnCount: 9,
      gamePhase: 'playing',
      characterSheet: null,
      playerName: '调查员',
      selectedOccupationId: null,
      selectedOccupationName: '',
      sessionId: 'sess',
    })

    await store.loadGame('old-save')
    expect(store.longTermSummary).toBe('')
    expect(store.longTermFacts).toEqual([])
  })
})
