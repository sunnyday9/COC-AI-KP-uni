import type { Message } from '../types/game'
import type { COCCharacterSheet } from '../types/character'
import { getSkillName } from '../data/coc7'

/**
 * 共享常量（Task 7 P0 修复）：原定义同时存在于 kpPromptService 与 gameStore，
 * 迁移时统一从此处导出，两处引用同一值，语义不变（30）。
 */
export const MAX_MEMORY_ENTRIES = 30
const RECENT_TURNS_COUNT = 5
const RECENT_TURN_ENTRY_LEN = 120
const CONVERSATION_WINDOW = 18

export interface PromptState {
  storyName: string
  currentScene: string
  cluesObtained: string[]
  messages: Message[]
  kpMemory: string[]
  longTermSummary: string
  playerName: string
  characterSheet: COCCharacterSheet | null
}

const BASE_INSTRUCTIONS = [
  '你是克苏鲁的呼唤第七版（COC 7th）的守密人（Keeper/KP）。',
  '你的所有故事知识来源于「故事情报」中检索到的原文片段。请严格基于这些片段进行叙事，不要凭空编造场景或 NPC。',
  '保持洛夫克拉夫特式的恐怖氛围。',
  '',
  '【信息披露与防剧透】',
  '- 你掌握的“故事情报”是守密人内部参考，不代表玩家角色已知。',
  '- 绝对禁止提前泄露未来剧情、幕后真相、隐藏动机、未出场 NPC/地点/道具的关键作用。',
  '- 只允许披露：玩家当前所见所闻、已获得的线索（应通过 grant_clue 记录）、或基于当下证据的有限推断。',
  '- 如果检索到的片段明显属于未来场景/后续章节，只用于你决定“现在能否给线索/是否需要引导行动”，不要直接复述给玩家。',
  '- 叙事优先“给可操作的下一步”而不是“给完整答案”。必要时提出澄清问题（你具体检查哪里/如何做）。',
  '',
  '【严禁事项 — 违反将导致系统错误】',
  '- 绝对禁止在文字中自行编造骰子结果（如"d100: 45"、"投骰 1d8 = 4"等）。',
  '- 绝对禁止在文字中自行声称 HP/MP/SAN 变化（如"HP 降至 4"、"损失 3 SAN"等）。',
  '- 所有检定、投骰、数值变更必须且只能通过调用工具函数实现。',
  '- 工具返回结果后，你才能在叙事中提及结果。',
  '',
  '【检定规则】',
  '- 仅在有戏剧性冲突、不确定性或危险时才要求检定。日常/职业常规行动自动成功。',
  '- 需要检定时 → 调用 skill_check 工具（参数：技能名、技能值、难度；可选 bonusDice/penaltyDice、isPush 孤注一掷）。',
  '- 遭遇恐怖事物时 → 调用 san_check 工具；若发生 SAN 损失，再视情况调用 trigger_insanity(sanLost, intValue) 判定永久/不定性/临时疯狂与发作。',
  '- 失败 ≠ 完全失败：可以是部分成功、挫折或情况改变。',
  '- 检定失败后可提供"孤注一掷"选项（SAN检定和战斗检定除外），再次调用 skill_check 时设 isPush: true。',
  '- 玩家可在技能检定后选择消耗幸运：调用 spend_luck(amount)，不可用于幸运/SAN/伤害骰。',
  '',
  '【战斗规则 — 必须调用工具链】',
  '- 近战：优先调用 melee_attack（一次完成对抗检定、伤害加值、护甲减免、重伤/濒死/即死）；或分步调用 opposed_check → roll_dice → adjust_hp → apply_major_wound。',
  '- 远程：优先调用 ranged_attack（一次完成命中检定、伤害、护甲、重伤/濒死/即死）；或分步 skill_check → roll_dice → adjust_hp → apply_major_wound。',
  '- NPC 攻击玩家时同样必须完整调用工具链。',
  '- 禁止跳过任何步骤，禁止在文字中自编伤害数字。',
  '',
  '【线索传递】',
  '- 显明线索：不需检定，直接调用 grant_clue 工具。',
  '- 隐秘线索：需要检定成功后才调用 grant_clue。',
  '- 绝不让单一线索成为唯一推进路径。',
  '',
  '【场景管理】',
  '- 新游戏日开始（如过夜、休息后）时，调用 reset_day 工具重置当日 SAN 损失，以便不定性疯狂判定正确。',
  '- 当调查员移动到新地点时，调用 transition_scene 工具。',
  '- 场景名称来自故事原文，不要自行创造故事中不存在的地点。',
  '- 若调查员想去的地方在故事情报中没有提及，告知该处无事可做并引导回到故事主线。',
  '',
  '【叙事原则】',
  '- 描述证据而非结论（"地毯上有泥泞脚印" 而非 "有人闯入"）',
  '- 少即是多：暗示恐怖而非完全揭示',
  '- 使用全部感官（视觉、听觉、嗅觉、触觉）',
  '- 致命遭遇前给予至少两次警告暗示',
  '- 已叙述过的内容不要用相同措辞重复',
].join('\n')

export function buildCharacterContext(state: PromptState): string {
  const parts: string[] = []
  const char = state.characterSheet
  if (char) {
    const d = char.derived ?? { hp: 0, hpMax: 0, mp: 0, mpMax: 0, san: 0, sanMax: 0 }
    parts.push(`## 调查员: ${char.playerName} (${char.occupationName})`)
    parts.push(`HP ${d.hp}/${d.hpMax} MP ${d.mp}/${d.mpMax} SAN ${d.san}/${d.sanMax}`)
    if (char.damageBonus != null || char.build != null) parts.push(`伤害加值: ${char.damageBonus ?? '-'} 体格: ${char.build ?? '-'}`)
    if (char.armor != null && char.armor > 0) parts.push(`护甲: ${char.armor}`)
    if (char.weapons?.length) parts.push('武器: ' + char.weapons.map((w) => w.name + (w.damage ? ` ${w.damage}` : '')).join(', '))
    if (char.insanityState && char.insanityState !== 'normal') parts.push(`疯狂状态: ${char.insanityState}`)
    if (char.phobias?.length) parts.push(`恐惧症: ${char.phobias.join(', ')}`)
    if (char.manias?.length) parts.push(`躁狂症: ${char.manias.join(', ')}`)
    if (char.hasMajorWound) parts.push('重伤')
    if (char.isDying) parts.push('濒死')
    parts.push(
      `属性: STR ${char.attributes.str} CON ${char.attributes.con} SIZ ${char.attributes.siz} DEX ${char.attributes.dex} APP ${char.attributes.app} INT ${char.attributes.int} POW ${char.attributes.pow} EDU ${char.attributes.edu} Luck ${char.attributes.luck}`,
    )
    const skillLines = Object.entries(char.skills)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${getSkillName(k)}: ${v}%`)
    if (skillLines.length) parts.push('技能: ' + skillLines.join(', '))
  }
  if (state.storyName) parts.push(`\n## 故事: ${state.storyName}`)
  if (state.currentScene) parts.push(`当前场景: ${state.currentScene}`)
  if (state.cluesObtained.length) {
    parts.push('\n### 已获线索')
    for (const desc of state.cluesObtained) parts.push(`- ${desc}`)
  }
  return parts.join('\n')
}

export function buildMemoryBlock(kpMemory: string[]): string {
  if (kpMemory.length === 0) return ''
  const lines = kpMemory.slice(-MAX_MEMORY_ENTRIES).map((s) => s.trim()).filter(Boolean)
  return `\n## 记忆：你（守密人）在本局已说过的内容\n以下是你已经向调查员表述过的内容，请避免用相同或高度相似的措辞重复。每次回应请用新的表述方式推进剧情。\n${lines.map((t) => `- ${t}`).join('\n')}\n`
}

export function buildRecentTurnsBlock(msgs: Message[], maxTurns: number = RECENT_TURNS_COUNT): string {
  const filtered = msgs.filter(
    (m): m is Message => (m.role === 'kp' || m.role === 'player') && !(m.role === 'kp' && (m as { isStreaming?: boolean }).isStreaming),
  )
  if (filtered.length === 0) return ''
  const pairs: string[] = []
  let i = filtered.length - 1
  while (i >= 0 && pairs.length < maxTurns) {
    const kp = filtered[i]
    if (!kp || kp.role !== 'kp') {
      i--
      continue
    }
    const kpContent =
      ('content' in kp ? String(kp.content) : '').trim().slice(0, RECENT_TURN_ENTRY_LEN) +
      (('content' in kp ? String(kp.content) : '').length > RECENT_TURN_ENTRY_LEN ? '…' : '')
    i--
    const playerMsg = i >= 0 ? filtered[i] : undefined
    if (playerMsg && playerMsg.role === 'player') {
      const playerContent =
        ('content' in playerMsg ? String(playerMsg.content) : '').trim().slice(0, RECENT_TURN_ENTRY_LEN) +
        (('content' in playerMsg ? String(playerMsg.content) : '').length > RECENT_TURN_ENTRY_LEN ? '…' : '')
      const name = 'playerName' in playerMsg ? playerMsg.playerName : '调查员'
      pairs.unshift(`玩家(${name}): ${playerContent} → 守密人: ${kpContent}`)
      i--
    } else {
      pairs.unshift(`守密人: ${kpContent}`)
    }
  }
  if (pairs.length === 0) return ''
  return `\n## 最近几轮\n${pairs.map((p) => `- ${p}`).join('\n')}\n`
}

export function buildOpeningPrompt(state: PromptState, ragContext: string): { systemPrompt: string; chatMessages: { role: 'system' | 'user'; content: string }[] } {
  const charContext = buildCharacterContext(state)
  const memoryBlock = buildMemoryBlock(state.kpMemory)
  const longTermBlock = state.longTermSummary ? `\n## 长期记忆（本局至今）\n${state.longTermSummary}\n` : ''
  const ragBlock = ragContext ? `\n## 故事情报\n${ragContext}\n` : ''
  const systemPrompt = `${BASE_INSTRUCTIONS}${longTermBlock}${memoryBlock}${ragBlock}\n## 当前状态\n${charContext}\n\n请根据故事情报，向调查员做开场白，描述他们所处的场景，营造神秘与悬疑氛围。`
  const chatMessages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: '请开始游戏，向调查员做开场白。' },
  ]
  return { systemPrompt, chatMessages }
}

export function buildTurnPrompt(
  state: PromptState,
  ragContext: string,
): { systemPrompt: string; chatMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] } {
  const charContext = buildCharacterContext(state)
  const memoryBlock = buildMemoryBlock(state.kpMemory)
  const longTermBlock = state.longTermSummary ? `\n## 长期记忆（本局至今）\n${state.longTermSummary}\n` : ''
  const recentTurnsBlock = buildRecentTurnsBlock(state.messages)
  const ragBlock = ragContext ? `\n## 故事情报\n${ragContext}` : ''
  const systemPrompt = `${BASE_INSTRUCTIONS}${longTermBlock}${memoryBlock}${recentTurnsBlock}${ragBlock}\n\n## 当前状态\n${charContext}`

  const conv = state.messages
    .filter((m) => (m.role === 'kp' || m.role === 'player') && !(m.role === 'kp' && (m as { isStreaming?: boolean }).isStreaming))
    .slice(-CONVERSATION_WINDOW)
  const chatMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...conv.map((m) => ({
      role: m.role === 'player' ? ('user' as const) : ('assistant' as const),
      content: m.role === 'player' ? `[${(m as any).playerName}] ${'content' in m ? m.content : ''}` : ('content' in m ? (m as any).content : ''),
    })),
  ]

  return { systemPrompt, chatMessages }
}
