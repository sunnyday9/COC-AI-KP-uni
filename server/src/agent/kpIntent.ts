/**
 * Lightweight, deterministic KP intent vocabulary shared by the real graph
 * and the MOCK_AI provider. Keeping this leaf free of LangGraph dependencies
 * prevents provider setup and room tests from loading the full graph merely
 * to classify a player message.
 */

const INTENT_RULES_ORDER: Array<{ re: RegExp; intent: string }> = [
  // dossier 查证词：叙事性信息动作 → narrative（避免误判 investigate 强制授线索）
  { re: /情报确认|查证一下|查一下档案|查阅档案|确认一下/, intent: 'narrative' },
  { re: /战斗|攻击|开枪|射击|格斗|挥拳|扑向|砍|刺|开枪打/, intent: 'combat' },
  { re: /撬锁|开锁/, intent: 'skill_check' },
  // 调查(?!员): the word 调查员 (investigator) must NOT trigger an action.
  { re: /侦查|搜索|检查|查看|搜寻|翻找|搜查|调查(?!员)/, intent: 'investigate' },
  { re: /恐怖|疯狂|尖叫|理智|诡异|吓人|毛骨悚然/, intent: 'san_encounter' },
  { re: /对话|询问|交谈|打听|说服|恐吓|问.{0,6}(?:情况|消息|下落)/, intent: 'talk_npc' },
  { re: /移动|前往|走到|走进|进入|来到|离开|跑去|奔向/, intent: 'move' },
  { re: /使用|掏出|拿出|服用|佩戴/, intent: 'use_item' },
  { re: /骰|检定|投掷/, intent: 'skill_check' },
]

export function classifyIntentByRules(userText: string): string | null {
  const text = String(userText || '').trim()
  if (!text) return null
  for (const rule of INTENT_RULES_ORDER) {
    if (rule.re.test(text)) return rule.intent
  }
  return null
}

/** Combat skills whose successful checks continue into a damage roll. */
export const COMBAT_SKILLS = ['格斗', '射击', '手枪', '步枪', '投掷', '弓术', '斧', '刀', '矛', '鞭', '拳']
