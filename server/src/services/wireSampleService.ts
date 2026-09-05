/**
 * wireSampleService — KP 回合 wire 采样日志（T1，spec #36 / ADR-0006「唯一新缝」）。
 *
 * 每个真实 KP 回合把完整 wire 消息序列持久化落库，让之后的每一场对局自动积累
 * 严格可复现的 SFT 训练素材（kpTurnService.runKpTurn 在回合收口处调用本服务）：
 *   - wire_messages = 回合初始 messages（system 含 RAG/记忆/近窗注入）+ 各工具
 *     循环轮的 [assistant(tool_calls 原始参数 JSON), tool 结果回填（线上同形态：
 *     摘要+截断，即 LLM 实际看到的文本）] + 最终叙事 assistant 消息——按序还原
 *     即该回合发给 LLM 的完整序列；
 *   - 存储走 node:sqlite（kp_wire_samples 表），不进 rooms.state——房间快照协议
 *     与对账行为零改动（ADR-0001/0002）；
 *   - 默认开启（KP_WIRE_SAMPLING=0 关闭，关闭时零额外写入）；MOCK_AI=1 的确定性
 *     脚本回合不是真实模型输出，不进 SFT 语料；写库失败只告警，绝不影响回合本身
 *     （采样不改变任何线上行为）。
 */
import { getDb } from '../db/index.js'
import { isMockAiMode, isKpWireSamplingEnabled } from '../config.js'
import { logger } from '../utils/logging.js'
import { errorMessage } from '../utils/errors.js'

/** 一个工具循环轮的 wire 片段：assistant 原文 + 原始 tool_calls（参数 JSON 字符串）+ 回填的 tool 消息。 */
export interface KpWireSampleIteration {
  assistantContent: string
  toolCalls: { id: string; name: string; arguments: string }[]
  toolResults: { role: 'tool'; tool_call_id: string; content: string }[]
}

/** runKpTurn 采样元数据（KpTurnDeps.sampling；ownerId 由 runKpTurn 自身持有）。 */
export interface KpWireSamplingMeta {
  roomId: string
  storyId: string | null
  /** 当轮 RAG 注入原文（flushTurn / opening 检索结果；空串 = 无注入）。 */
  ragContext: string
}

/** 原始 tool_call → OpenAI wire 形态（msgs 追加与采样重建共用，格式单点）。 */
export function toOpenAiToolCall(t: { id: string; name: string; arguments: string }): {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
} {
  return { id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }
}

/** runKpTurn 收口传给采样服务的回合数据（ownerId 即 KP 回合的解析账号 = 现任房主）。 */
export interface KpWireSampleInput {
  roomId: string
  ownerId: number
  storyId: string | null
  /** 当轮 RAG 注入原文（flushTurn / opening 检索结果；空串 = 无注入）。 */
  ragContext: string
  /** 回合初始 messages（system 含 RAG/记忆/近窗注入，即发给 LLM 的开头）。 */
  initialMessages: unknown[]
  iterations: KpWireSampleIteration[]
  finalContent: string
}

/** kp_wire_samples 行（snake_case 直出，供测试 / 后续导出器读取）。 */
export interface KpWireSampleRow {
  id: number
  room_id: string
  turn_seq: number
  owner_id: number
  story_id: string | null
  rag_context: string
  tool_calls: string
  wire_messages: string
  created_at: number
}

/** wire 消息序列 = 初始消息 + 各轮 [assistant(tool_calls), tool 回填…] + 最终叙事 assistant。 */
export function buildWireMessages(
  input: Pick<KpWireSampleInput, 'initialMessages' | 'iterations' | 'finalContent'>,
): unknown[] {
  const out: unknown[] = [...input.initialMessages]
  for (const it of input.iterations) {
    out.push({
      role: 'assistant',
      content: it.assistantContent,
      ...(it.toolCalls.length ? { tool_calls: it.toolCalls.map(toOpenAiToolCall) } : {}),
    })
    out.push(...it.toolResults)
  }
  out.push({ role: 'assistant', content: input.finalContent })
  return out
}

/** 落库一条 KP 回合 wire 采样（同步写；任何失败只告警——采样不改变线上行为）。 */
export function recordKpWireSample(input: KpWireSampleInput): void {
  if (!isKpWireSamplingEnabled()) return
  if (isMockAiMode()) return
  try {
    const db = getDb()
    // turn_seq = 房间内 MAX+1。opening 回合走 enqueue 而 flushTurn 不走，二者可并发，
    // 读+写必须在 IMMEDIATE 事务内原子完成；UNIQUE(room_id, turn_seq) 硬约束兜底
    //（万一仍冲突：丢弃该条采样并告警，回合不受影响）。
    db.exec('BEGIN IMMEDIATE')
    try {
      const seq = db
        .prepare(`SELECT COALESCE(MAX(turn_seq), 0) + 1 AS seq FROM kp_wire_samples WHERE room_id = ?`)
        .get(input.roomId) as { seq: number }
      db.prepare(
        `INSERT INTO kp_wire_samples (room_id, turn_seq, owner_id, story_id, rag_context, tool_calls, wire_messages, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.roomId,
        seq.seq,
        input.ownerId,
        input.storyId,
        input.ragContext,
        JSON.stringify(input.iterations.flatMap((it) => it.toolCalls)),
        JSON.stringify(buildWireMessages(input)),
        Date.now(),
      )
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    logger.warn('kp:wire-sample insert failed', { roomId: input.roomId, error: errorMessage(err) })
  }
}

/** 按房间读取采样（turn_seq 升序）——T1 验收「还原任一回合」与后续导出器（#40）共用。 */
export function listWireSamplesForRoom(roomId: string): KpWireSampleRow[] {
  return getDb()
    .prepare(`SELECT * FROM kp_wire_samples WHERE room_id = ? ORDER BY turn_seq ASC`)
    .all(roomId) as unknown as KpWireSampleRow[]
}
