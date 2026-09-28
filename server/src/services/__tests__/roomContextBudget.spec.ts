import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRoomTurnMessages } from '../kpPromptService.js'
import { RoomService } from '../roomService.js'

afterEach(() => vi.unstubAllEnvs())

describe('room context budget', () => {
  it('keeps the newest transcript context within the configured per-room budget', () => {
    const messages = buildRoomTurnMessages(
      {
        storyName: '',
        scene: null,
        clues: [],
        messages: [
          { role: 'player', playerName: 'alice', content: 'old-history-marker' },
          { role: 'kp', content: 'old keeper response' },
          { role: 'player', playerName: 'alice', content: 'recent action' },
          { role: 'kp', content: 'recent keeper response' },
        ],
        kpMemory: [],
        longTermSummary: '',
        characters: [],
      },
      '',
      'current action',
      { contextBudgetChars: 32 },
    )

    const transcript = messages.slice(1, -1)
    const transcriptText = transcript.map((message) => message.content).join('')
    expect(transcriptText).not.toContain('old-history-marker')
    expect(transcript.at(-1)?.content).toBe('recent keeper response')
    expect(transcript.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(32)
  })

  it('restores a persisted room budget and uses configuration for legacy snapshots', () => {
    vi.stubEnv('ROOM_CONTEXT_BUDGET_CHARS', '640')
    const legacy = new RoomService({
      roomId: 'legacy-context-budget',
      ownerId: 1,
      ownerName: 'alice',
      restore: {
        seq: 0,
        phase: 'playing',
        storyId: null,
        messages: [],
        characters: {},
        clues: [],
        scene: null,
        ending: null,
        turnWindowMs: 0,
        updatedAt: 0,
      },
    })
    const persisted = new RoomService({
      roomId: 'persisted-context-budget',
      ownerId: 1,
      ownerName: 'alice',
      restore: {
        seq: 0,
        phase: 'playing',
        storyId: null,
        messages: [],
        characters: {},
        clues: [],
        scene: null,
        ending: null,
        turnWindowMs: 0,
        contextBudgetChars: 320,
        updatedAt: 0,
      },
    })

    expect(legacy.snapshot().contextBudgetChars).toBe(640)
    expect(persisted.snapshot().contextBudgetChars).toBe(320)
    legacy.dispose()
    persisted.dispose()
  })
})
