/**
 * T1 wire 采样房间链路测试（spec #36 / #37）—— flushTurn → runKpTurnForRoom →
 * runKpTurn 全真实链（仅图执行/LLM/RAG/记忆桩）。
 *
 * 覆盖票 #37 验收：
 *  - 房间链路落库：RAG 注入原文从 flushTurn 流到采样行且进入 wire system 消息；
 *  - 快照恢复兼容性：采样不触碰 rooms.state——快照键集合不变、无采样字段渗入、
 *    restore 往返一致（ADR-0001/0002 房间协议零改动）；
 *  - KP_WIRE_SAMPLING=0 时房间链路零额外写入。
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
}))
vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => []),
  summarizeLongTerm: vi.fn(async () => ''),
}))
vi.mock('../ragService.js', () => ({
  context: vi.fn(async () => ({ context: '【RAG 检索】场景：旧图书馆——地下室的门后有刮擦声。' })),
  listStories: vi.fn(() => []),
}))

import { invokeKPAgent } from '../../agent/kpGraph.js'
import * as roomStorage from '../roomStorage.js'
import { RoomService, type RoomSnapshot } from '../roomService.js'
import { listWireSamplesForRoom } from '../wireSampleService.js'

const invokeKPAgentMock = vi.mocked(invokeKPAgent)

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const SNAPSHOT_KEYS = [
  'characters',
  'clues',
  'ending',
  'kpMemory',
  'longTermSummary',
  'messages',
  'phase',
  'scene',
  'seq',
  'storyId',
  'turnWindowMs',
  'updatedAt',
]

describe('wire 采样房间链路（T1）', () => {
  beforeEach(() => {
    invokeKPAgentMock.mockReset()
    // 缺省：一次推理直接产出最终叙事（无工具轮）
    invokeKPAgentMock.mockResolvedValue({ content: '最终叙事回复。', toolCalls: [] })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('flushTurn 链路：RAG 注入流到采样行且进入 wire system；快照零改动 + restore 往返一致', async () => {
    // 第一轮带工具调用，第二轮走缺省叙事（最终回复）
    invokeKPAgentMock.mockResolvedValueOnce({
      content: '你推开图书馆的门。',
      toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: '{"sides":100}' }],
    })
    roomStorage.insertRoom('room_flow', 7, 'INV-FLOW-1', null)
    const room = new RoomService({ roomId: 'room_flow', ownerId: 7, ownerName: 'alice', turnWindowMs: 0 })
    try {
      room.startGame('story_flow1')
      room.bufferPlayerChat('alice', '我走进图书馆。', null, 7)
      await waitFor(() => room.getMessages().some((m) => m.role === 'kp'))

      const rows = listWireSamplesForRoom('room_flow')
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.room_id).toBe('room_flow')
      expect(row.owner_id).toBe(7)
      expect(row.story_id).toBe('story_flow1')
      expect(row.turn_seq).toBe(1)
      // 当轮 RAG 注入原文（flushTurn 检索结果）独立成列
      expect(row.rag_context).toContain('刮擦声')

      const wire = JSON.parse(row.wire_messages) as { role: string; content?: string; tool_calls?: unknown[] }[]
      // wire system 消息同样包含 RAG 注入（buildRoomTurnMessages 注入的『## 故事情报』块）
      expect(wire[0]).toMatchObject({ role: 'system' })
      expect(String(wire[0]!.content)).toContain('## 故事情报')
      expect(String(wire[0]!.content)).toContain('刮擦声')
      // 合并后的本批玩家行动
      expect(wire.some((m) => m.role === 'user' && m.content === '【alice】我走进图书馆。')).toBe(true)
      // 最终叙事 = 玩家实际看到的 KP 回复（多段拼接）
      expect(wire.at(-1)).toMatchObject({ role: 'assistant' })
      expect(String(wire.at(-1)!.content)).toContain('最终叙事回复。')

      // 带一轮工具调用，wire 依序包含 assistant(tool_calls) + tool 回填
      expect(row.tool_calls).toContain('roll_dice')
      expect(wire.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true)
      expect(wire.some((m) => m.role === 'tool')).toBe(true)

      // ── 快照恢复兼容性：采样零渗入 rooms.state（ADR-0001/0002）──
      await room.persistSnapshot()
      const stateJson = roomStorage.getRoomRow('room_flow')!.state
      expect(stateJson).not.toContain('wire_messages')
      expect(stateJson).not.toContain('rag_context')
      expect(stateJson).not.toContain('tool_calls')
      const parsed = JSON.parse(stateJson) as RoomSnapshot
      expect(Object.keys(parsed).sort()).toEqual(SNAPSHOT_KEYS)
      // restore 往返：消息流 / 角色 / 剧情 / 阶段完全一致
      const restored = new RoomService({ roomId: 'room_flow', ownerId: 7, ownerName: 'alice', restore: parsed })
      try {
        expect(restored.getStoryId()).toBe('story_flow1')
        expect(restored.getPhase()).toBe('playing')
        expect(restored.getMessages().map((m) => [m.role, m.content])).toEqual(
          room.getMessages().map((m) => [m.role, m.content]),
        )
        expect(restored.getCharacters().size).toBe(room.getCharacters().size)
      } finally {
        restored.dispose()
      }
    } finally {
      room.dispose()
    }
  })

  it('KP_WIRE_SAMPLING=0：房间链路零额外写入（KP 回合照常）', async () => {
    vi.stubEnv('KP_WIRE_SAMPLING', '0')
    roomStorage.insertRoom('room_off', 7, 'INV-OFF-1', null)
    const room = new RoomService({ roomId: 'room_off', ownerId: 7, ownerName: 'alice', turnWindowMs: 0 })
    try {
      room.startGame('story_flow1')
      room.bufferPlayerChat('alice', '我看看门。', null, 7)
      await waitFor(() => room.getMessages().some((m) => m.role === 'kp'))

      // KP 回合行为不变，但采样表零写入
      expect(room.getMessages().some((m) => m.role === 'kp' && m.content === '最终叙事回复。')).toBe(true)
      expect(listWireSamplesForRoom('room_off')).toHaveLength(0)
    } finally {
      room.dispose()
    }
  })
})
