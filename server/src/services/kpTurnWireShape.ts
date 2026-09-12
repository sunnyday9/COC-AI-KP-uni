/**
 * kpTurnWireShape — KP 回合工具循环上限 + 工具结果 wire 回填形态的单源（票 #75）。
 *
 * 只含常量与纯函数，零 fs/db/运行时服务依赖：
 *   - 线上 kpTurnService.runKpTurn 以此限制工具循环轮数、回填 tool 结果
 *     （【结果摘要】头 + 截断 JSON，即 LLM 实际看到的 wire）；
 *   - 离线 training distill replay 直引同一实现——「线上同形态」由 import 保证，
 *     不再靠逐字复制 + 注释锚定（历史：replay.ts 曾整段复制本组常量/函数，
 *     理由「kpTurnService 模块拖 agent/db 运行时栈不可离线 import」已失效；
 *     客户端第二份副本已在 D-29 删除，此处把 training 侧最后一份副本收为单源）。
 *
 * 阈值是训练数据形状的一部分（SFT wire 序列），改动即线上/离线同时漂移，需评审。
 */

export const MAX_TOOL_ITERATIONS = 8

/** Cap the tool-result payload echoed back into the conversation (long-chain
 * degradation guard): the trace bus already keeps the full result, so the
 * LLM only needs the head of the JSON. */
export const MAX_TOOL_RESULT_CHARS = 600
/** Head of a tool result: first-level key/value pairs, for the LLM to see the
 * outcome at a glance without the full JSON (long tool chains echo history). */
export const MAX_TOOL_RESULT_SUMMARY_CHARS = 120

export function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
}

/** Build a compact `{success, skillName, roll, …}` summary head for tool results. */
export function summarizeToolResult(content: string): string {
  try {
    const data = JSON.parse(content) as Record<string, unknown>
    if (data === null || typeof data !== 'object') return ''
    const pairs: string[] = []
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      pairs.push(`${k}: ${s.slice(0, 40)}`)
      if (pairs.length >= 6) break
    }
    if (pairs.length === 0) return ''
    let head = `【结果摘要】${pairs.join('；')}`
    if (head.length > MAX_TOOL_RESULT_SUMMARY_CHARS) {
      head = `${head.slice(0, MAX_TOOL_RESULT_SUMMARY_CHARS)}…`
    }
    return head + '\n'
  } catch {
    return ''
  }
}
