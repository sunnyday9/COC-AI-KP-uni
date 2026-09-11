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
  getSettings: vi.fn(() => ({ rag: { supplement: true } })),
}))
vi.mock('../roomMemory.js', () => ({
  extractMemoryPoints: vi.fn(async () => []),
  summarizeLongTerm: vi.fn(async () => ''),
}))
vi.mock('../ragService.js', () => ({
  buildGetEmbeddingForUser: vi.fn(async () => null),
  listStories: vi.fn(() => []),
}))
/** 桩检索补充层（M1-T6）：rag 房情报块出自标准管线（graphRag 路径已退役）。 */
vi.mock('../../rag/supplementService.js', () => ({
  buildSupplement: vi.fn(async () => ({
    section: '## 原文片段（检索补充·仅作描写素材）\n场景：旧图书馆——地下室的门后有刮擦声。',
    blocks: [
      {
        id: 'c1',
        text: '【RAG 检索】场景：旧图书馆——地下室的门后有刮擦声。',
        score: 0.9,
        attribution: 'none',
        scenes: [],
        crossScene: false,
      },
    ],
    chars: 60,
    droppedSpoiler: 0,
    droppedOverlap: 0,
    query: '桩',
    degraded: false,
    revealRegions: 0,
    durationMs: 1,
  })),
  defaultRewrite: () => undefined,
}))

/** 桩档案服务（dossier 房：场景块走档案，补充小节走检索）。
 *  coverageGaps 桩需保留 `regions.js` 的常量再导出（supplementAssembly 的
 *  场景区域/归一化走那条轻链）。 */
vi.mock('../../rag/dossier/storyDossierService.js', () => ({
  loadDossier: vi.fn(async () => ({ storyName: '雾中镇', scenes: [{ id: 's1', name: '门厅', sceneText: '门厅的铜灯。' }], npcs: [], clues: [], transitions: [], events: [], truths: [], endings: [] })),
  buildSceneBlock: vi.fn(() => '场景：门厅\n简介：进门处。'),
  listScenes: vi.fn(() => [{ id: 's1', name: '门厅' }]),
  findScene: vi.fn(() => ({ id: 's1', name: '门厅' })),
  // #53：房间场景与档案对不上时的提示（本 spec 的场景恒为命中，故不会被调用；
  // 但 mock 必须导出它——vitest 对缺失导出**抛错**，会被 fetchDossierContext 的
  // catch 吞成空块，症状是"档案块凭空消失"）
  renderSceneUncovered: vi.fn((name: string, names: string[]) => `【场景归属提示】档案未覆盖当前场景「${name}」。档案中的场景：${names.join('、')}。`),
}))
vi.mock('../../rag/dossier/coverageGaps.js', async () => {
  const regions = await vi.importActual<typeof import('../../rag/dossier/regions.js')>('../../rag/dossier/regions.js')
  return {
    loadGaps: vi.fn(async () => null),
    computeSceneCoverage: vi.fn(() => null),
    SCENE_REGION_LEAD: regions.SCENE_REGION_LEAD,
    SCENE_REGION_SPAN: regions.SCENE_REGION_SPAN,
    normalizeText: regions.normalizeText,
  }
})

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
  'workflow',
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

  it('M1-T6：dossier 房注入列 = 场景档案块 + 检索补充小节，且两者都进 wire system', async () => {
    roomStorage.insertRoom('room_dos', 7, 'INV-DOS-1', null)
    const room = new RoomService({ roomId: 'room_dos', ownerId: 7, ownerName: 'alice', turnWindowMs: 0, workflow: 'dossier' })
    try {
      room.startGame('story_dos1')
      room.bufferPlayerChat('alice', '我看看门厅。', null, 7)
      await waitFor(() => room.getMessages().some((m) => m.role === 'kp'))

      const row = listWireSamplesForRoom('room_dos')[0]!
      // 注入列语义扩展：场景块在前、补充小节在后
      expect(row.rag_context).toContain('场景：门厅')
      expect(row.rag_context).toContain('## 原文片段（检索补充·仅作描写素材）')
      expect(row.rag_context.indexOf('场景：门厅')).toBeLessThan(row.rag_context.indexOf('## 原文片段'))

      // 提示词里小节位于档案块之后，且带双轨口径说明
      const wire = JSON.parse(row.wire_messages) as { role: string; content?: string }[]
      const sys = String(wire[0]!.content)
      expect(sys).toContain('## 当前场景档案')
      expect(sys.indexOf('## 当前场景档案')).toBeLessThan(sys.indexOf('## 原文片段（检索补充·仅作描写素材）'))
      expect(sys).toContain('以档案为准')
    } finally {
      room.dispose()
    }
  })

  it('M1-T6：rag.supplement=false → 小节完全消失、检索不发生', async () => {
    const { getSettings } = await import('../settingsService.js')
    const { buildSupplement } = await import('../../rag/supplementService.js')
    const { buildGetEmbeddingForUser } = await import('../ragService.js')
    vi.mocked(getSettings).mockReturnValue({ rag: { supplement: false } } as never)
    vi.mocked(buildSupplement).mockClear()
    vi.mocked(buildGetEmbeddingForUser).mockClear()
    roomStorage.insertRoom('room_off2', 7, 'INV-OFF-2', null)
    const room = new RoomService({ roomId: 'room_off2', ownerId: 7, ownerName: 'alice', turnWindowMs: 0, workflow: 'dossier' })
    try {
      room.startGame('story_dos2')
      room.bufferPlayerChat('alice', '我看看门厅。', null, 7)
      await waitFor(() => room.getMessages().some((m) => m.role === 'kp'))

      // 检索**完全没有发生**（不是发生了再丢弃）
      expect(buildSupplement).not.toHaveBeenCalled()
      // 连嵌入器都没构建（关开关 = 零模型成本，不只是零注入）
      expect(buildGetEmbeddingForUser).not.toHaveBeenCalled()
      const row = listWireSamplesForRoom('room_off2')[0]!
      expect(row.rag_context).not.toContain('## 原文片段')
      const wire = JSON.parse(row.wire_messages) as { role: string; content?: string }[]
      expect(String(wire[0]!.content)).not.toContain('## 原文片段（检索补充·仅作描写素材）')
      expect(String(wire[0]!.content)).toContain('## 当前场景档案')
    } finally {
      vi.mocked(getSettings).mockReturnValue({ rag: { supplement: true } } as never)
      room.dispose()
    }
  })
})
