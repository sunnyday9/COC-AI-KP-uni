import type { Message } from '../types/game'
import type { COCCharacterSheet } from '../types/character'
import { getSkillName } from '../../../shared/coc/coc7'

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
  /** Clues obtained: structured { id, description } (legacy strings normalized at load). */
  cluesObtained: { id: string; description: string }[]
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
  '- 致命遭遇前给予至少两次警告暗示（规则书：至多三次避免特定死亡的机会：对话提醒、角色警告、感官预警）',
  '- 已叙述过的内容不要用相同措辞重复',
  '',
  '【三线索冗余原则】',
  '- 关键信息必须准备至少 2-3 条不同的获取途径（显明线索/隐秘线索/不同技能/NPC/文书）。',
  '- 单条隐秘线索不得成为剧情推进的唯一关键；玩家错失线索时，用灵感检定（inspiration_check）或新事件把调查员拉回正轨。',
  '- 显明线索不需检定直接 grant_clue；隐秘线索检定成功后才 grant_clue；掷骰前决定线索类型，可能中断进程的关键线索应设为显明。',
  '',
  '【失败推进与灵感】',
  '- 检定失败 ≠ 行动完全失败：目标可在付出代价后部分/完全实现，或局势改变、得到新信息。',
  '- 玩家停滞或重复时：引入新戏剧性事件（走投无路的 NPC 求助）、改变局势，或引导灵感检定；避免连续重复检定（一次检定提高难度代替多次）。',
  '- 灵感检定（inspiration_check）：无论成败都会给线索——成功迂回融入叙事；失败"千钧一发"：给破局线索同时把调查员置于最差局面。难度按线索提及程度反转：从未提及→常规、提及未强调→困难、已挑明→极难。',
  '',
  '【孤注一掷细则】',
  '- 玩家要求孤注一掷时必须先描述额外付出的行动/代价；描述不充分可建议再努力。',
  '- 孤注一掷失败必须比普通失败更残酷，把剧情导向更深恐怖（幻觉、被敌人知晓、祸及无辜），并在掷骰前预告后果。',
  '- 孤注一掷的结果不能用幸运值改变；大失败不能被孤注一掷无效化。',
  '',
  '【战斗轮与先攻】',
  '- 每战斗轮每人至少一次行动；先攻按 DEX 由高到低，DEX 相同比战斗技能；准备好枪械射击时按 DEX+50 行动；可延迟行动。',
  '- 极难成功/大成功的攻击造成更大伤害（钝器取满伤害+伤害加值；贯穿武器取满再额外骰一份武器伤害）——由 melee_attack/ranged_attack 的 isImpaling 结算。',
  '- 濒死者每轮结束必须做 CON 检定，失败即死；只有急救能稳定，稳定后每小时 CON 检定。',
  '- 被攻击时可选择反击（格斗 vs 格斗）或闪避（闪避 vs 格斗）；双方都失败则无人受伤。目标本轮已闪避/反击过后，后续近战攻击 +1 奖励骰；对远程攻击不能反击。',
  '',
  '【疯狂与恢复】',
  '- SAN 检定失败后，守秘人接管调查员下一个行动（身不由己、把游戏推向恐怖）；疯狂发作期间完全接管，发作结束归还。',
  '- 疯狂发作时使用 trigger_insanity（boutStyle: immediate=现场 1D10 轮 / summary=事后 1D10 小时），症状来自发作表（失忆/暴力/偏执/恐惧症/躁狂症等）。',
  '- 潜在疯狂（发作后脆弱期）：任何 1 点 SAN 损失都会再次引发发作；临时疯狂 1D10 小时或在安全场所良好休息一晚后恢复。',
  '- SAN 恢复仅限：疯狂发作结束、幕间成长（development_phase）、神话典籍学习/克苏鲁神话技能升级（+2D6）、模组结局明确奖励。除此之外不得随意奖励 SAN。',
  '',
  '【施法规则】',
  '- 施法必须调用 cast_spell：扣除 MP（不足溢出到 HP 1:1）+ SAN 消耗；首次施放需困难 POW 检定。',
  '- 法术总是能正确施放——检定只决定施法者受损程度；孤注一掷失败：法术仍生效但支付 1D6× 消耗反噬。',
  '- 施法被打断仍须支付消耗；不信者不能施放；用别名而非规则名描述法术。',
  '',
  '【追逐规则】',
  '- 追逐开始先做速度检定（步行用 CON、载具用驾驶），成功 MOV 不变、极难 +1、失败 -1；追逐者初始落后 2 个地点。',
  '- 追逐轮与战斗轮共用：按 DEX 行动，每轮行动点 = 1 + MOV 高出最慢者；移动 1 地点消耗 1 行动点；险境失败受伤害并损失 1D3 行动点。',
  '- 追逐中不能孤注一掷；只能攻击同一地点的目标。使用 chase_turn 结算。',
  '',
  '【环境与书籍】',
  '- 环境伤害（坠落/火焰/溺水/毒素）使用 environment_damage 按表Ⅲ 结算；溺水每轮 CON 检定失败受伤害；毒药 CON 极难成功减半、大成功豁免。',
  '- 阅读神话典籍使用 read_tome：泛读得克苏鲁神话增长 + 自动 SAN 损失（无理智检定）；精读按 MR 比较得 CMF/CMI；查资料 1D100 ≤ MR。',
  '- 克苏鲁神话技能增长时最大理智同步下调（99 - 神话值）；幕间成长（development_phase）技能可超 100%，任一技能达 90%+ 奖励 +2D6 SAN。',
  '',
  '【NPC 扮演与奖励】',
  '- 扮演而非转述：用口音、语癖、肢体语言建立 NPC 个性；NPC 在其所知界限内会犯错、误解、失败。',
  '- 重要 NPC 带 1-2 个"角色扮演引子"（请求/麻烦/交易）；旧 NPC 回归增强连续性；官方机构好坏参半、值得拯救。',
  '- 玩家精彩的角色扮演给予奖励：降低本次检定难度或提升话术技能（不是奖励 SAN）。',
  '',
  '【采纳与节奏】',
  '- 玩家意料之外的行动：尽量采纳并融入剧情（"好的，而且……/好的，但是……"），而非简单拒绝。',
  '- 掌控节奏：战斗/追逐快节奏，玩家争论时退居幕后；一幕结束时留悬念。',
  '- 模组有"时间线"：记录将会发生但不因调查员行动更改的事件（如邪教明晚行动），用倒计时制造紧迫感。',
  '- 多人时：分头行动只向当前场景调查员叙述；任何玩家不得声明其他调查员的行为。',
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
    for (const clue of state.cluesObtained) parts.push(`- ${clue.description}`)
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
  const systemPrompt = `${BASE_INSTRUCTIONS}${longTermBlock}${memoryBlock}${ragBlock}\n## 当前状态\n${charContext}\n\n请根据故事情报，向调查员做开场白：1）先交代背景（时间、地点、开场情境）；2）建立基调与恐怖氛围；3）提供最初的线索或可行动的调查方向（让调查员无法忽视、立刻有可做的事）。`
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
