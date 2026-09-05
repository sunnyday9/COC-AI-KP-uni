/**
 * KP 数据导出器核心（T2，spec #36 / 票 #38 / ADR-0006「后果」第 2 条）。
 *
 * 从既有对局快照与存档导出「上下文 + 玩家行动流」骨架：每行 = 一个 KP 回合的
 * context 侧（system + 近窗对话 + 收尾玩家行动）+ 线上 24 工具定义，即 OpenAI
 * messages + tools JSONL（Hermes 风格）——#40 教师重放在此骨架上生成理想回复。
 *
 * 来源与优先级（票 #38 验收 3）：
 *  - room        rooms.state 快照逐回合切片；该回合有 wire 采样（#37 kp_wire_samples）
 *                → 优先真实注入（initialMessages 逐字拷贝，meta.source='wire'）；
 *  - orphan-wire 房间已被 TTL 回收（rooms 行删除、采样仍在）的孤儿采样独立导出——
 *                房间短暂、采样长存，这是长期数据积累的主路径；
 *  - save        旧版单人存档（GameSaveSnapshot）确定性重建。
 *
 * 无采样的回合走确定性重建：复用服务端提示词纯函数（kpPromptService 的
 * buildRoomTurnMessages / buildRoomOpeningMessages / injectCharacterRoster——与
 * roomService.flushTurn → runKpTurn 完全同一条组装路径），保证训练样本与线上请求
 * 同构（票 #38 验收 2）。离线不可得的输入如实标注（meta.caveats）：
 *  - rag_context_unavailable_offline：RAG 检索依赖在线 embedding，重建行 RAG 注入为空；
 *  - state_blocks_from_final_snapshot：记忆/线索/场景等状态块取自终局快照（开场行
 *    例外——opening 在空状态上运行，可完全重建）。
 *
 * 本模块只读 DB（全部参数绑定 SELECT），不 import server 运行时（db/config/agent 栈）。
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { COC_KP_TOOLS, type KpToolDef } from '../../shared/tools/cocTools.js'
import type { COCCharacterSheet } from '../../shared/types/character.js'
import type { Message, PlayerMessage } from '../../shared/types/game.js'
import {
  OPENING_USER_REQUEST,
  buildRoomOpeningMessages,
  buildRoomTurnMessages,
  injectCharacterRoster,
  type RoomChatMessage,
  type RoomPromptInput,
} from '../../server/src/services/kpPromptService.js'

/* ── 输出形态 ─────────────────────────────────────────────── */

export interface ExportMeta {
  kind: 'opening' | 'turn'
  /** wire = 落库采样的真实注入逐字拷贝；rebuilt = 提示词纯函数确定性重建。 */
  source: 'wire' | 'rebuilt'
  /** 数据出处：room 在场房间 / orphan-wire 已回收房间的采样 / save 旧版存档。 */
  origin: 'room' | 'orphan-wire' | 'save'
  roomId: string | null
  saveId: string | null
  userId: number
  storyId: string | null
  storyName: string
  /** wire 采样的 turn_seq（重建行 null——历史局无采样序号）。 */
  turnSeq: number | null
  /** 游戏流内的回合序（1 起，opening 计入）。 */
  turnIndex: number
  /** 本批玩家行动条数（opening 为 0）。 */
  batchPlayerMessages: number
  messagesInContext: number
  /** 实际进入 system 的 RAG 注入字符数（重建行为 0）。 */
  ragContextChars: number
  caveats: string[]
}

export interface ExportLine {
  meta: ExportMeta
  messages: RoomChatMessage[]
  tools: KpToolDef[]
}

export interface ExportStats {
  lines: number
  wire: number
  rebuilt: number
  opening: number
  rooms: number
  orphanWireRooms: number
  saves: number
}

export interface ExportResult {
  lines: ExportLine[]
  stats: ExportStats
  /** 跳过的坏行（JSON 解析失败等）——不中断导出，但必须可见。 */
  warnings: string[]
}

export interface ExportOptions {
  dbPath: string
  /** 过滤：缺省 = 全量。 */
  roomIds?: string[]
  saveIds?: string[]
  includeRooms?: boolean
  includeOrphanWire?: boolean
  includeSaves?: boolean
}

/* ── DB 行与游戏流切片 ─────────────────────────────────────── */

interface KpWireSampleRow {
  room_id: string
  turn_seq: number
  owner_id: number
  story_id: string | null
  rag_context: string
  wire_messages: string
}

interface RoomRow {
  room_id: string
  owner_id: number
  story_id: string | null
  state: string
}

interface SaveRow {
  user_id: number
  save_id: string
  data: string
}

/** 游戏流切出的一个回合（context 侧输入）。 */
export interface StreamTurn {
  kind: 'opening' | 'turn'
  /** 本批之前的完整消息流（kp/system 展示消息由纯函数内部过滤）。 */
  history: Message[]
  batch: PlayerMessage[]
  /** 线上 flushTurn 的合并格式：`【username】content` 逐条换行拼接；opening = 固定开场请求。 */
  batchContent: string
  turnIndex: number
}

/**
 * 消息流 → 回合切片（与 roomService 的窗口合并语义互逆）：玩家消息即时入流、
 * flushTurn 把窗口内连续玩家消息合并为一个回合，故流中每段连续 player 消息 =
 * 一个批量；首条 player 之前的 kp 叙事块 = opening 回合（opening 在空状态上运行）。
 */
export function extractStreamTurns(messages: Message[]): StreamTurn[] {
  const turns: StreamTurn[] = []
  const firstPlayerIdx = messages.findIndex((m) => m.role === 'player')
  const leadEnd = firstPlayerIdx === -1 ? messages.length : firstPlayerIdx
  // opening：首条 player 前存在 KP 叙事（opening 回合的回复；失败兜底的 system 消息不算）
  if (messages.slice(0, leadEnd).some((m) => m.role === 'kp')) {
    turns.push({ kind: 'opening', history: [], batch: [], batchContent: OPENING_USER_REQUEST, turnIndex: 1 })
  }
  let idx = leadEnd
  while (idx < messages.length) {
    if (messages[idx]!.role !== 'player') {
      idx++
      continue
    }
    const batchStart = idx
    while (idx < messages.length && messages[idx]!.role === 'player') idx++
    const batch = messages.slice(batchStart, idx) as PlayerMessage[]
    turns.push({
      kind: 'turn',
      history: messages.slice(0, batchStart),
      batch,
      batchContent: batch.map((m) => `【${m.playerName}】${m.content}`).join('\n'),
      turnIndex: turns.length + 1,
    })
  }
  return turns
}

/* ── 重建 / wire 投影 ─────────────────────────────────────── */

const CAVEAT_RAG = 'rag_context_unavailable_offline'
const CAVEAT_FINAL_STATE = 'state_blocks_from_final_snapshot'

/** wire 采样行的 initialMessages 投影：wire_messages 首个 assistant 之前的前缀（context 侧）。 */
function contextFromWireSample(row: KpWireSampleRow): RoomChatMessage[] {
  const msgs = JSON.parse(row.wire_messages) as { role: string; content: string }[]
  const out: RoomChatMessage[] = []
  for (const m of msgs) {
    if (m.role === 'assistant') break
    out.push({ role: m.role as 'system' | 'user', content: String(m.content) })
  }
  return out
}

/**
 * wire 采样的批量匹配键 = 序列中**最后一条 user 消息**的内容（回合的收尾批量
 * user 消息；opening 为固定开场请求）。wire 行在批量之后还跟 assistant/tool 响应
 * 轮与最终叙事，故不能取「最后一条消息」。
 */
function wireBatchKey(row: KpWireSampleRow): string | null {
  try {
    const msgs = JSON.parse(row.wire_messages) as { role: string; content: string }[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'user') return String(msgs[i]!.content)
    }
    return null
  } catch {
    return null
  }
}

/**
 * wire 采样 ↔ 流回合 匹配（双指针）：samples 按 turn_seq 升序是流回合的时间子序列
 * （失败/中断回合无采样），按序内容相等即配对；同文案重复批量按时间序一一对应。
 * 已知近似：连续两个完全相同文案的批量中前者无采样时会错配到后者的采样（system
 * 状态块有细微时差错位）——批文案全同在真实对局中罕见，接受并在此存证。
 */
function matchWireSamples(turns: StreamTurn[], samples: KpWireSampleRow[]): Map<number, KpWireSampleRow> {
  const matched = new Map<number, KpWireSampleRow>()
  let s = 0
  for (const turn of turns) {
    if (s < samples.length && wireBatchKey(samples[s]!) === turn.batchContent) {
      matched.set(turn.turnIndex, samples[s]!)
      s++
    }
  }
  return matched
}

interface GameContextSource {
  userId: number
  storyId: string | null
  storyName: string
  scene: string | null
  clues: { id: string; description: string }[]
  characters: Record<string, COCCharacterSheet> | COCCharacterSheet[]
  kpMemory: string[]
  longTermSummary: string
}

/** opening 重建输入：线上 opening 恒在空状态运行（messages/memory/clues/scene 皆空）。 */
function openingPromptInput(src: GameContextSource): RoomPromptInput {
  return {
    storyName: src.storyName,
    scene: null,
    clues: [],
    messages: [],
    kpMemory: [],
    longTermSummary: '',
    characters: Object.values(src.characters as Record<string, COCCharacterSheet>),
  }
}

function characterMap(src: GameContextSource): Record<string, COCCharacterSheet> {
  return Array.isArray(src.characters)
    ? Object.fromEntries(src.characters.map((c, i) => [`char_${i}`, c]))
    : src.characters
}

/** 终局快照确定性重建一个回合的 context（与 flushTurn → runKpTurn 的组装路径同源）。 */
function rebuildContext(src: GameContextSource, turn: StreamTurn): RoomChatMessage[] {
  const map = characterMap(src)
  const input: RoomPromptInput =
    turn.kind === 'opening'
      ? openingPromptInput(src)
      : {
          storyName: src.storyName,
          scene: src.scene,
          clues: src.clues,
          messages: turn.history,
          kpMemory: src.kpMemory,
          longTermSummary: src.longTermSummary,
          characters: Object.values(map),
        }
  const base =
    turn.kind === 'opening'
      ? buildRoomOpeningMessages(input, '')
      : buildRoomTurnMessages(input, '', turn.batchContent)
  return injectCharacterRoster(base, map) as RoomChatMessage[]
}

function makeLine(meta: Omit<ExportMeta, 'messagesInContext'>, messages: RoomChatMessage[]): ExportLine {
  return { meta: { ...meta, messagesInContext: messages.length }, messages, tools: COC_KP_TOOLS }
}

/* ── 主流程 ─────────────────────────────────────────────── */

export function exportKpContext(options: ExportOptions): ExportResult {
  if (!fs.existsSync(options.dbPath)) {
    throw new Error(`DB 文件不存在: ${options.dbPath}（server 默认 data 目录见 server/src/config.ts DATA_DIR）`)
  }
  const db = new DatabaseSync(options.dbPath)
  const warnings: string[] = []
  const lines: ExportLine[] = []
  const stats: ExportStats = { lines: 0, wire: 0, rebuilt: 0, opening: 0, rooms: 0, orphanWireRooms: 0, saves: 0 }

  const storyNames = new Map<string, string>()
  for (const row of db.prepare(`SELECT user_id, story_id, name FROM stories`).all() as unknown as { user_id: number; story_id: string; name: string }[]) {
    storyNames.set(`${row.user_id}:${row.story_id}`, row.name)
  }

  const samplesByRoom = new Map<string, KpWireSampleRow[]>()
  for (const row of db
    .prepare(`SELECT room_id, turn_seq, owner_id, story_id, rag_context, wire_messages FROM kp_wire_samples ORDER BY room_id, turn_seq ASC`)
    .all() as unknown as KpWireSampleRow[]) {
    const list = samplesByRoom.get(row.room_id) ?? []
    list.push(row)
    samplesByRoom.set(row.room_id, list)
  }

  const roomIds = options.roomIds?.length ? options.roomIds : null
  const roomRows = (
    roomIds
      ? db.prepare(`SELECT room_id, owner_id, story_id, state FROM rooms WHERE room_id IN (${roomIds.map(() => '?').join(', ')}) ORDER BY room_id ASC`).all(...roomIds)
      : db.prepare(`SELECT room_id, owner_id, story_id, state FROM rooms ORDER BY room_id ASC`).all()
  ) as unknown as RoomRow[]
  const roomIdsSeen = new Set(roomRows.map((r) => r.room_id))

  const saveIds = options.saveIds?.length ? options.saveIds : null
  const saveRows = (
    saveIds
      ? db.prepare(`SELECT user_id, save_id, data FROM saves WHERE save_id IN (${saveIds.map(() => '?').join(', ')}) ORDER BY user_id, save_id ASC`).all(...saveIds)
      : db.prepare(`SELECT user_id, save_id, data FROM saves ORDER BY user_id, save_id ASC`).all()
  ) as unknown as SaveRow[]

  db.close()

  const pushLine = (meta: Omit<ExportMeta, 'messagesInContext'>, messages: RoomChatMessage[]) => {
    lines.push(makeLine(meta, messages))
    stats.lines++
    if (meta.source === 'wire') stats.wire++
    else stats.rebuilt++
    if (meta.kind === 'opening') stats.opening++
  }

  /* 1) 在场房间：流切片 + wire 优先 */
  if (options.includeRooms !== false) {
    for (const room of roomRows) {
      stats.rooms++
      let state: { messages?: Message[]; scene?: string | null; clues?: { id: string; description: string }[]; characters?: Record<string, COCCharacterSheet>; kpMemory?: string[]; longTermSummary?: string }
      try {
        state = JSON.parse(room.state) as unknown as typeof state
      } catch (err) {
        warnings.push(`room ${room.room_id}: state JSON 解析失败，已跳过（${err instanceof Error ? err.message : String(err)}）`)
        continue
      }
      const turns = extractStreamTurns(state.messages ?? [])
      const src: GameContextSource = {
        userId: room.owner_id,
        storyId: room.story_id,
        storyName: (room.story_id && storyNames.get(`${room.owner_id}:${room.story_id}`)) || '',
        scene: state.scene ?? null,
        clues: state.clues ?? [],
        characters: state.characters ?? {},
        kpMemory: state.kpMemory ?? [],
        longTermSummary: state.longTermSummary ?? '',
      }
      const matched = matchWireSamples(turns, samplesByRoom.get(room.room_id) ?? [])
      for (const turn of turns) {
        const sample = matched.get(turn.turnIndex)
        if (sample) {
          let messages: RoomChatMessage[]
          try {
            messages = contextFromWireSample(sample)
          } catch (err) {
            warnings.push(`room ${room.room_id}#${sample.turn_seq}: wire_messages 解析失败，已跳过（${err instanceof Error ? err.message : String(err)}）`)
            continue
          }
          pushLine(
            {
              kind: turn.kind, source: 'wire', origin: 'room', roomId: room.room_id, saveId: null,
              userId: room.owner_id, storyId: room.story_id ?? null, storyName: src.storyName,
              turnSeq: sample.turn_seq, turnIndex: turn.turnIndex,
              batchPlayerMessages: turn.batch.length, ragContextChars: sample.rag_context.length, caveats: [],
            },
            messages,
          )
        } else {
          pushLine(
            {
              kind: turn.kind, source: 'rebuilt', origin: 'room', roomId: room.room_id, saveId: null,
              userId: room.owner_id, storyId: room.story_id ?? null, storyName: src.storyName,
              turnSeq: null, turnIndex: turn.turnIndex,
              batchPlayerMessages: turn.batch.length, ragContextChars: 0,
              caveats: turn.kind === 'opening' ? [CAVEAT_RAG] : [CAVEAT_RAG, CAVEAT_FINAL_STATE],
            },
            rebuildContext(src, turn),
          )
        }
      }
    }
  }

  /* 2) 孤儿 wire 采样：房间已回收，采样独立成行 */
  if (options.includeOrphanWire !== false) {
    for (const [roomId, samples] of samplesByRoom) {
      if (roomIdsSeen.has(roomId) || (roomIds && !roomIds.includes(roomId))) continue
      stats.orphanWireRooms++
      for (const sample of samples) {
        let messages: RoomChatMessage[]
        try {
          messages = contextFromWireSample(sample)
        } catch (err) {
          warnings.push(`orphan wire ${roomId}#${sample.turn_seq}: wire_messages 解析失败，已跳过（${err instanceof Error ? err.message : String(err)}）`)
          continue
        }
        // 开场样本以固定开场请求收尾（线上 opening 恒以它收尾）；回收前批量大小不可考，
        // batchPlayerMessages 记 1（收尾 user 消息数）作为下界
        const isOpening = messages.length >= 2 && messages[messages.length - 1]!.content === OPENING_USER_REQUEST
        pushLine(
          {
            kind: isOpening ? 'opening' : 'turn', source: 'wire', origin: 'orphan-wire',
            roomId, saveId: null, userId: sample.owner_id, storyId: sample.story_id,
            storyName: (sample.story_id && storyNames.get(`${sample.owner_id}:${sample.story_id}`)) || '',
            turnSeq: sample.turn_seq, turnIndex: sample.turn_seq,
            batchPlayerMessages: isOpening ? 0 : 1, ragContextChars: sample.rag_context.length, caveats: [],
          },
          messages,
        )
      }
    }
  }

  /* 3) 旧版单人存档：全量重建（存档无 room 关联，不可能有采样） */
  if (options.includeSaves !== false) {
    for (const save of saveRows) {
      stats.saves++
      let data: Record<string, unknown>
      try {
        data = JSON.parse(save.data) as Record<string, unknown>
      } catch (err) {
        warnings.push(`save ${save.save_id}: data JSON 解析失败，已跳过（${err instanceof Error ? err.message : String(err)}）`)
        continue
      }
      const messages = (data.messages ?? []) as Message[]
      const sheet = data.characterSheet as unknown as COCCharacterSheet | null
      const src: GameContextSource = {
        userId: save.user_id,
        storyId: (data.storyId as string | null) ?? null,
        storyName: (data.storyName as string) || '',
        scene: (data.currentScene as string) || null,
        clues: (data.cluesObtained as { id: string; description: string }[]) ?? [],
        characters: sheet ? [sheet] : [],
        kpMemory: (data.kpMemory as string[]) ?? [],
        longTermSummary: (data.longTermSummary as string) ?? '',
      }
      for (const turn of extractStreamTurns(messages)) {
        pushLine(
          {
            kind: turn.kind, source: 'rebuilt', origin: 'save', roomId: null, saveId: save.save_id,
            userId: save.user_id, storyId: src.storyId, storyName: src.storyName,
            turnSeq: null, turnIndex: turn.turnIndex,
            batchPlayerMessages: turn.batch.length, ragContextChars: 0,
            caveats: turn.kind === 'opening' ? [CAVEAT_RAG] : [CAVEAT_RAG, CAVEAT_FINAL_STATE],
          },
          rebuildContext(src, turn),
        )
      }
    }
  }

  return { lines, stats, warnings }
}

/** 导出结果 → JSONL（每行一条样本，UTF-8；空结果返回空串）。 */
export function renderJsonl(lines: ExportLine[]): string {
  if (lines.length === 0) return ''
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
