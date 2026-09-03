/**
 * parseActionOptions —— KP 消息「可选行动」解析（#27 项 5 DRY）。
 * 行为契约 = 原 KPMessage.vue 内联解析（#19 提取，ADR-0004 消息类型体系）：
 * 找「可选行动」引导头 → 头后列表项（行首 -/1. 等符号）剥离成选项按钮文案；
 * 无引导头时回退匹配消息尾部裸列表。仅当 0 < 选项数 ≤ 6 才作为选项返回，
 * 其余文本（含列表后的尾随文字）拼回正文。
 */
const OPTION_HEADER_RE = /(?:【?可选行动】?|你可以选择[：:]|接下来[你]?打算怎么做[？?]|选项[：:]|你[可以]?的选择[：:])\s*\n+/
const FALLBACK_LIST_RE = /\n+((?:(?:[-*+]|\d+\.)\s+[^\n]+(?:\n|$))+)$/

export interface ParsedKpContent {
  /** 展示正文（选项已剥离；尾随文字拼回）。 */
  text: string
  /** 0..6 个行动选项文案（超出 6 个时按无选项处理，正文原样返回）。 */
  options: string[]
}

function stripListMark(line: string): string {
  return line.replace(/^(?:[-*+]|\d+\.)\s+/, '').replace(/\*\*/g, '').trim()
}

/** KP 正文是否在流式输出中 —— 流式期间不解析（防抖动，调用方判断）。 */
export function shouldParseOptions(msg: { role: string; isStreaming?: boolean }): boolean {
  return msg.role === 'kp' && !msg.isStreaming
}

/**
 * 解析 KP 消息正文。非 KP 角色/空内容 → 原样返回无选项。
 * 选项数超过 6（含 0）→ 视为正文，不改动原文本。
 */
export function parseActionOptions(content: string, role: string): ParsedKpContent {
  const text = content ?? ''
  if (role !== 'kp' || !text) return { text, options: [] }

  // 引导头模式：主文本 + 头后列表 + 可能的尾随文字
  const headMatch = text.match(OPTION_HEADER_RE)
  if (headMatch && headMatch.index !== undefined) {
    const mainText = text.substring(0, headMatch.index).trim()
    const afterHeader = text.substring(headMatch.index + headMatch[0].length)
    const options: string[] = []
    const trailing: string[] = []
    let inList = true
    for (const rawLine of afterHeader.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (inList && /^(?:[-*+]|\d+\.)\s+/.test(line)) {
        options.push(stripListMark(line))
      } else {
        inList = false
        trailing.push(line)
      }
    }
    if (options.length > 0 && options.length <= 6) {
      const finalText = mainText + (trailing.length ? '\n\n' + trailing.join('\n') : '')
      return { text: finalText || text, options }
    }
    // 超 6 项 → 不采用（正文原样），落入 fallback 判断
  }

  // 回退：正文尾部恰为裸列表（无引导头）
  const fbMatch = text.match(FALLBACK_LIST_RE)
  if (fbMatch) {
    const mainText = text.substring(0, fbMatch.index).trim()
    const options = fbMatch[1]!
      .split('\n')
      .map(stripListMark)
      .filter((line) => line.length > 0)
    if (options.length > 0 && options.length <= 6) {
      return { text: mainText || text, options }
    }
  }

  return { text, options: [] }
}
