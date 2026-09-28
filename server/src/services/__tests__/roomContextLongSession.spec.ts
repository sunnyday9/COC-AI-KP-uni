import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedMessage {
  role: string
  content: string
}

interface SummaryInput {
  recentMessagesText: string
  recentToolResultsText?: string
  currentSummary: string
}

const state = vi.hoisted(() => ({
  prompts: [] as CapturedMessage[][],
  summaryInputs: [] as SummaryInput[],
  turnCalls: 0,
  rejectNextSummary: false,
}))

vi.mock('../kpTurnService.js', () => ({
  runKpTurn: vi.fn(async (
    _userId: number,
    body: { messages: CapturedMessage[] },
    turn: {
      handlers: {
        onEnd: (result: {
          content: string
          displayMessages: unknown[]
          toolCalls: unknown[]
          worldDeltas: { cluesAdded: unknown[] }
          characterSheet: null
        }) => void
      }
    },
  ) => {
    state.prompts.push(body.messages)
    state.turnCalls += 1
    const displayMessages = state.turnCalls === 8
      ? [{
          id: 'dice-important-result',
          timestamp: Date.now(),
          role: 'system',
          type: 'dice',
          content: '侦查检定：困难成功',
          result: { skill: '侦查', roll: 17, target: 65, outcome: '困难成功' },
        }]
      : []
    turn.handlers.onEnd({
      content: `守密人叙述 ${state.turnCalls}`,
      displayMessages,
      toolCalls: [],
      worldDeltas: { cluesAdded: [] },
      characterSheet: null,
    })
  }),
}))

vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => []),
  summarizeLongTerm: vi.fn(async (_userId: number, payload: SummaryInput) => {
    state.summaryInputs.push(payload)
    if (state.rejectNextSummary) {
      state.rejectNextSummary = false
      throw new Error('summary service unavailable')
    }
    const checkpoint = `checkpoint-${state.summaryInputs.length}`
    return payload.currentSummary ? `${payload.currentSummary}\n${checkpoint}` : checkpoint
  }),
}))

vi.mock('../startGate.js', () => ({
  checkStartGate: vi.fn(async () => ({ ok: true })),
  sanitizeWorkflow: (workflow: unknown) => workflow === 'dossier' ? 'dossier' : 'rag',
}))

vi.mock('../turnKnowledge.js', () => ({
  assembleTurnKnowledge: vi.fn(async () => ({
    storyName: '长会话测试剧本',
    ragContext: '',
    sceneBlock: '',
    verifyBlock: '',
    supplement: '',
    wireInjectionText: '',
    terminalEndings: [],
  })),
  buildStoryLookup: vi.fn(() => undefined),
}))

import { RoomService, _clearRoomRegistryForTests, createSoloRoom, getOrCreateRoom, joinRoom } from '../roomService.js'
import { getDb } from '../../db/index.js'

const CONTEXT_BUDGET_CHARS = 320
const sheet = {
  playerName: 'Alice',
  occupationName: '侦探',
  attributes: { str: 50, con: 60, siz: 55, dex: 70, app: 50, int: 75, pow: 60, edu: 80, luck: 55 },
  skills: { 侦察: 65 },
  derived: { hp: 10, hpMax: 12, mp: 8, mpMax: 12, san: 55, sanMax: 60, damageBonus: '0', moveRate: 8 },
}

let userIdSequence = 36_000

function seedUser(username: string): number {
  const id = ++userIdSequence
  getDb().prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(id, username, Date.now())
  return id
}

beforeEach(() => {
  state.prompts.length = 0
  state.summaryInputs.length = 0
  state.turnCalls = 0
  state.rejectNextSummary = false
  vi.stubEnv('MOCK_AI', '1')
  vi.stubEnv('ROOM_CONTEXT_BUDGET_CHARS', String(CONTEXT_BUDGET_CHARS))
})

afterEach(() => {
  _clearRoomRegistryForTests()
  vi.unstubAllEnvs()
})

async function createPlayingRoom(username: string) {
  const userId = seedUser(username)
  const created = await createSoloRoom(userId, {
    storyId: `story_${username}`,
    name: 'Alice',
    sheet,
  })
  if (!created.ok) throw new Error(created.message)
  const room = joinRoom(created.roomId, userId, username)
  if (!room) throw new Error('expected room membership')
  await vi.waitFor(() => expect(state.turnCalls).toBe(1)) // Opening is the first KP call.
  return { userId, roomId: created.roomId, room }
}

function retainedConversationChars(messages: CapturedMessage[]): number {
  return messages.slice(1, -1).reduce((total, message) => total + message.content.length, 0)
}

describe('RoomService long-session context', () => {
  it.each([20, 40])('bounds prompts and restores compacted context after %i turns', async (turnCount) => {
    const { userId, roomId, room } = await createPlayingRoom(`context_${turnCount}`)
    room.setScene('旧图书馆')
    room.addClue('钥匙孔里的红色纤维')
    await vi.waitFor(() => expect(room.snapshot().longTermSummary).toContain('checkpoint-1'))

    for (let turn = 1; turn <= turnCount; turn += 1) {
      const expectedCalls = state.turnCalls + 1
      room.submitPlayerChat(userId, `turn-${turn}-unique-marker ${'调查旧档案'.repeat(24)}`)
      await vi.waitFor(() => expect(state.turnCalls).toBe(expectedCalls))

      const prompt = state.prompts.at(-1)!
      expect(prompt.at(-1)?.content).toContain(`turn-${turn}-unique-marker`)
      expect(retainedConversationChars(prompt)).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS)
      if (turn % 10 === 0) {
        const expectedSummaries = 1 + turn / 10 // Initial scene summary plus periodic checkpoints.
        await vi.waitFor(() => expect(state.summaryInputs.length).toBe(expectedSummaries))
      }
    }

    const finalPrompt = state.prompts.at(-1)!
    expect(finalPrompt.slice(1, -1).some((message) => message.content.includes('turn-1-unique-marker'))).toBe(false)
    expect(state.summaryInputs.some((input) => input.recentToolResultsText?.includes('困难成功'))).toBe(true)

    const expectedSummary = room.snapshot().longTermSummary
    const fullTranscriptStillAvailable = room.snapshot().messages.some((message) => message.content.includes('turn-1-unique-marker'))
    expect(fullTranscriptStillAvailable).toBe(true)

    _clearRoomRegistryForTests()
    const restored = getOrCreateRoom(roomId, userId, `context_${turnCount}`)
    expect(restored.snapshot().longTermSummary).toBe(expectedSummary)
    expect(restored.snapshot().contextBudgetChars).toBe(CONTEXT_BUDGET_CHARS)
    expect(restored.snapshot().scene).toBe('旧图书馆')
    expect(restored.snapshot().clues).toContainEqual(expect.objectContaining({ description: '钥匙孔里的红色纤维' }))
    expect(restored.getCharacters()).toHaveLength(1)
  })

  it('keeps a player turn successful when a scheduled summary fails', async () => {
    const { userId, room } = await createPlayingRoom('context_summary_failure')
    state.rejectNextSummary = true

    for (let turn = 1; turn <= 10; turn += 1) {
      const expectedCalls = state.turnCalls + 1
      room.submitPlayerChat(userId, `failure-test-turn-${turn}`)
      await vi.waitFor(() => expect(state.turnCalls).toBe(expectedCalls))
    }

    expect(room.getMessages().filter((message) => message.role === 'player')).toHaveLength(10)
    expect(room.getMessages().some((message) => message.role === 'kp' && message.content.includes('守密人叙述 11'))).toBe(true)
    await vi.waitFor(() => expect(state.summaryInputs).toHaveLength(1))
    expect(room.snapshot().longTermSummary).toBe('')
  })
})
