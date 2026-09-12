/**
 * rooms.state JSON 文档 codec（#61）——读点容错解析 / 写点序列化的单点收口。
 *
 * rooms.state 是 JSON 文档列（列无 workflow/turnWindowMs 等结构列），此前 9 处散点
 * 各自手搓 JSON.parse/JSON.stringify + try/catch + as 断言（roomStorage solo 列表
 * preview、startGate workflow 解析、roomService restore/详情/settings/persistSnapshot
 * 等）。本模块只负责「可靠地读出 / 写回」：
 *  - parse 失败（空值/空串/脏 JSON）→ null 或 fallback，由调用方保留各自既有容错
 *    分支（'' 摘要 / 'rag' / 默认快照 / {} 透传——语义不一，特意不统一）；
 *  - 解析成功 → 原样返回，不附加对象守卫（各调用点对「合法 JSON 但非对象」的既有
 *    行为——null 透传 / 抛 TypeError 传播 / 外层 catch 吞掉——各自保持）；
 *  - 写回是整体覆盖语义（现状写点不存在 merge-patch），合并逻辑不得进 codec。
 * 字段级类型守卫与列优先对账/自愈等业务修补语义留在 RoomService / startGate /
 * roomStorage 各调用方。零依赖纯函数：startGate（无 fs/db 运行时依赖形态）可安全
 * 引用。
 */

/**
 * rooms.state 文档容错解析：空值/空串/脏 JSON → null；解析成功 → 原样返回。
 * 「解析成功但值为 JSON null」与「解析失败」同样返回 null——调用方（restore /
 * workflow / preview 读点）对两者的既有处理本就相同。
 */
export function parseRoomState<T = unknown>(state: string | null | undefined): T | null {
  if (!state) return null
  try {
    return JSON.parse(state) as T
  } catch {
    return null
  }
}

/**
 * rooms.state 文档容错解析（透传版）：解析失败 → fallback；解析成功 → 原样返回
 * （含 JSON null——getRoomDetail / setRoomTurnWindow 的现状透传语义，不得被
 * `?? {}` 之类的默认值改写）。
 */
export function parseRoomStateOr(state: string | null | undefined, fallback: unknown): unknown {
  if (!state) return fallback
  try {
    return JSON.parse(state)
  } catch {
    return fallback
  }
}

/** rooms.state 文档序列化（写回单点；整体覆盖语义由调用方表达）。 */
export function serializeRoomState(value: unknown): string {
  return JSON.stringify(value)
}
