import type { Message } from '../types/game'

/**
 * T4：系统消息视觉分类（ADR-0004 消息类型体系）。
 *
 * 房间消息流中系统消息为纯文本（服务端 rule-engine displayMessages 不携带 type
 * 字段——掷骰/属性变更都是裸 content 追加）。此处用文本形态推断视觉类别：
 * 只分类，不改变消息模型（ticket #19 AC：沿用 roomStore messages 数据形态）。
 *
 * 形态优先级（服务器产生这些前缀，见 rule-engine/handlers/*）：
 *  1. 战斗伤害 = HP ±N（adjust_hp）
 *  2. 属性变更 = SAN/MP ±N（sanity/resource handlers）
 *  3. 场景切换 = `场景切换: X`（narrativeHandler）
 *  4. 线索获得 = `获得线索: X`（narrativeHandler）
 *  5. 掷骰卡 = `检定 d100:` 或 `d100:` 段（check/combat/rules/sanity handlers）
 */
export type SystemMessageKind =
  | 'damage' // 战斗伤害（血色调）：HP ±N
  | 'stat' // 属性变更：SAN/MP ±N
  | 'scene' // 场景分隔卡：场景切换
  | 'clue' // 线索获得（左缘绿光条）
  | 'dice' // 掷骰结果卡（d100/dN）
  | 'generic' // 其他系统文本

export function classifySystemMessage(msg: Message): SystemMessageKind {
  const content = msg.content ?? ''
  if (/^HP\s[+-]/.test(content)) return 'damage'
  if (/^(SAN|MP)\s[+-]/.test(content)) return 'stat'
  if (content.startsWith('场景切换')) return 'scene'
  if (content.startsWith('获得线索')) return 'clue'
  if (/检定\s*d100\s*:?\s*\d|d100\s*[:：]\s*\d|[dD]\d+[:：]\s*\d/.test(content)) return 'dice'
  if (/^对抗检定\b|^近战\s*:|^远程\s*:/.test(content)) return 'dice'
  return 'generic'
}
