/**
 * T2 数据导出器测试（spec #36 / 票 #38）——金样本 fixture 快照 + 线上同构对拍。
 *
 * 覆盖票 #38 验收：
 *  - 对任一历史对局可导出完整可检视的 JSONL（context 与玩家行动逐条对应）→ 金样本快照；
 *  - 重建的 prompt 与线上请求形态同构（同一提示词纯函数产出）→ 用 buildRoomTurnMessages /
 *    injectCharacterRoster 直接对拍重建行；
 *  - 无 wire 日志的历史局可导出（标注「重建」来源）；有日志的局优先真实注入 → source/origin/caveats；
 *  - 用 e2e demo 剧本局做 fixture 快照测试 → fixtureDb（旧图书馆的铜钥匙）。
 */
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COC_KP_TOOLS } from '../../shared/tools/cocTools.js'
import type { COCCharacterSheet } from '../../shared/types/character.js'
import {
  OPENING_USER_REQUEST,
  buildRoomOpeningMessages,
  buildRoomTurnMessages,
  injectCharacterRoster,
  type RoomPromptInput,
} from '../../server/src/services/kpPromptService.js'
import { exportKpContext, extractStreamTurns, renderJsonl } from '../src/exporter.js'
import { ROOM_ID, SAVE_ID, createFixtureDb, roomDemoLibState, saveDemoLibData, type FixtureDb } from './fixtureDb.js'

let fixture: FixtureDb

beforeEach(() => {
  fixture = createFixtureDb()
})

afterEach(() => {
  fixture.dispose()
})

function exportAll() {
  return exportKpContext({ dbPath: fixture.dbPath })
}

/** 金样本投影：tools 只留名字清单（全量 tools 由独立断言深等，快照聚焦 meta + messages）。 */
function goldProjection(lines: ReturnType<typeof exportAll>['lines']) {
  return lines.map((l) => ({ meta: l.meta, messages: l.messages, toolNames: l.tools.map((t) => t.function.name) }))
}

describe('demo 剧本局金样本导出（票 #38）', () => {
  it('导出 6 行：房间 wire×2 + 房间重建×1 + 孤儿 wire×1 + 存档重建×2', () => {
    const { lines, stats } = exportAll()
    expect(lines).toHaveLength(6)
    expect(stats).toEqual({ lines: 6, wire: 3, rebuilt: 3, opening: 2, rooms: 1, orphanWireRooms: 1, saves: 1 })

    const keys = lines.map((l) => `${l.meta.origin}:${l.meta.source}:${l.meta.kind}`)
    expect(keys).toEqual([
      'room:wire:opening',      // room_demo_lib opening（真实注入）
      'room:wire:turn',         // room_demo_lib 回合1（真实注入）
      'room:rebuilt:turn',      // room_demo_lib 回合2（多人批量，无采样 → 重建）
      'orphan-wire:wire:turn',  // room_recycled（rooms 行已回收）
      'save:rebuilt:opening',   // save_demo_lib 开场
      'save:rebuilt:turn',      // save_demo_lib 回合1
    ])
  })

  it('每行 tools 与线上 COC_KP_TOOLS 深等（24 工具逐字）', () => {
    const { lines } = exportAll()
    expect(COC_KP_TOOLS.length).toBe(24)
    for (const line of lines) {
      expect(line.tools).toEqual(COC_KP_TOOLS)
    }
  })

  it('有 wire 采样的回合优先真实注入：messages = 落库 initialMessages 的逐字投影', () => {
    const { lines } = exportAll()
    const [opening, turn1] = lines
    expect(opening!.meta.turnSeq).toBe(1)
    expect(opening!.meta.ragContextChars).toBeGreaterThan(0)
    expect(opening!.messages).toEqual([
      { role: 'system', content: expect.stringContaining('### 房间内调查员（多人模式）') },
      { role: 'user', content: OPENING_USER_REQUEST },
    ])
    expect(turn1!.meta.turnSeq).toBe(2)
    expect(turn1!.messages[0]!.role).toBe('system')
    expect(turn1!.messages[1]).toEqual({ role: 'user', content: '【李云】我蹲下身，仔细检查那只青瓷花瓶的底部。' })
    // wire 行不包含 assistant/tool 响应侧（响应由 #40 教师重放生成，可经 turnSeq 回链全量采样）
    expect(turn1!.messages.some((m) => (m.role as string) === 'assistant' || (m.role as string) === 'tool')).toBe(false)
  })

  it('重建行与线上请求同构：与 buildRoomTurnMessages + injectCharacterRoster 直接对拍', () => {
    const { lines } = exportAll()
    const snap = roomDemoLibState() as unknown as {
      messages: { role: string; content: string }[]
      characters: Record<string, never>
      clues: { id: string; description: string }[]
      scene: string | null
      kpMemory: string[]
      longTermSummary: string
    }
    // 回合2：history = 流中最后一个批量（2 条 player）之前的全部消息——与 flushTurn 切片一致
    const history = snap.messages.slice(0, 4)
    const batch = '【艾琳】我去翻阅借阅台上的破损日记。\n【李云】我留意管理员的反应。'
    const input: RoomPromptInput = {
      storyName: 'demo-story',
      scene: snap.scene,
      clues: snap.clues,
      messages: history as never,
      kpMemory: snap.kpMemory,
      longTermSummary: snap.longTermSummary,
      characters: Object.values(snap.characters),
    }
    const expected = injectCharacterRoster(buildRoomTurnMessages(input, '', batch), snap.characters)
    const rebuilt = lines[2]!
    expect(rebuilt.messages).toEqual(expected)
    // 多人房间：重建 system 末尾带花名册块（线上 injectCharacterRoster 同形）
    expect(rebuilt.messages[0]!.content.endsWith('将作用于最后行动的调查员。')).toBe(true)
    expect(rebuilt.messages.at(-1)).toEqual({ role: 'user', content: batch })
  })

  it('重建行标注来源与离线限制：source=rebuilt + caveats（RAG 离线不可得 / 状态块取自终局快照）', () => {
    const { lines } = exportAll()
    const rebuiltTurn = lines[2]!
    expect(rebuiltTurn.meta.source).toBe('rebuilt')
    expect(rebuiltTurn.meta.turnSeq).toBeNull()
    expect(rebuiltTurn.meta.ragContextChars).toBe(0)
    expect(rebuiltTurn.meta.caveats).toEqual(['rag_context_unavailable_offline', 'state_blocks_from_final_snapshot'])

    const saveTurn = lines[5]!
    expect(saveTurn.meta.saveId).toBe(SAVE_ID)
    expect(saveTurn.meta.caveats).toEqual(['rag_context_unavailable_offline', 'state_blocks_from_final_snapshot'])
  })

  it('孤儿 wire 采样（rooms 行已回收）可导出且标注 origin', () => {
    const { lines } = exportAll()
    const orphan = lines[3]!
    expect(orphan.meta.origin).toBe('orphan-wire')
    expect(orphan.meta.roomId).not.toBe(ROOM_ID)
    expect(orphan.meta.source).toBe('wire')
    expect(orphan.meta.turnSeq).toBe(1)
    expect(orphan.messages).toHaveLength(2)
    expect(orphan.messages[1]).toEqual({ role: 'user', content: '【钟明】我翻阅那本破损日记的残页。' })
  })

  it('存档重建：开场行含固定开场请求，回合行含存档角色卡上下文', () => {
    const { lines } = exportAll()
    const saveOpening = lines[4]!
    const saveTurn = lines[5]!

    expect(saveOpening.meta.kind).toBe('opening')
    expect(saveOpening.messages[1]).toEqual({ role: 'user', content: OPENING_USER_REQUEST })
    // 开场回合在空状态上运行（与线上 opening 一致）：重建不含终局记忆/线索/场景
    const save = saveDemoLibData()
    const sheet = save.characterSheet as COCCharacterSheet
    const openInput: RoomPromptInput = {
      storyName: save.storyName as string,
      scene: null,
      clues: [],
      messages: [],
      kpMemory: [],
      longTermSummary: '',
      characters: [sheet],
    }
    expect(saveOpening.messages).toEqual(injectCharacterRoster(buildRoomOpeningMessages(openInput, ''), { save_character: sheet }))

    expect(saveTurn.messages.at(-1)).toEqual({ role: 'user', content: '【钟明】我向管理员打听地下室的来历。' })
    expect(JSON.stringify(saveTurn.messages[0])).toContain('## 调查员: 钟明 (古董商)')
  })

  it('金样本快照：demo 剧本局全量输出逐字节锁定（fixtures/gold-demo-export.json）', () => {
    const { lines } = exportAll()
    expect(renderJsonl(lines)).toContain('"meta"')
    const gold = JSON.stringify(goldProjection(lines), null, 2)
    expect(gold).toMatchFileSnapshot(path.resolve(import.meta.dirname, '../fixtures/gold-demo-export.json'))
  })
})

describe('extractStreamTurns（流→回合切片）', () => {
  it('开场块 + 批量合并：连续 player 消息合为一个回合，kp/system 展示消息归入响应侧', () => {
    const snap = roomDemoLibState() as unknown as { messages: never[] }
    const turns = extractStreamTurns(snap.messages)
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({ kind: 'opening', batchContent: OPENING_USER_REQUEST })
    expect(turns[1]).toMatchObject({ kind: 'turn', batchContent: '【李云】我蹲下身，仔细检查那只青瓷花瓶的底部。' })
    expect(turns[2]).toMatchObject({
      kind: 'turn',
      batchContent: '【艾琳】我去翻阅借阅台上的破损日记。\n【李云】我留意管理员的反应。',
    })
    expect(turns[2]!.history).toHaveLength(4)
  })

  it('无开场的流（opening 失败，首条即 player / 引导 system）不产出 opening 行', () => {
    const turns = extractStreamTurns([
      { id: 'sys_1', timestamp: 1, role: 'system', content: 'KP 回合失败，请稍后重试。' },
      { id: 'msg_1', timestamp: 2, role: 'player', playerName: '李云', content: '我推门而入。' },
      { id: 'kp_1', timestamp: 3, role: 'kp', content: '门后是灰尘弥漫的旧馆……' },
    ] as never[])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ kind: 'turn' })
    expect(turns[0]!.history).toHaveLength(1)
  })
})
