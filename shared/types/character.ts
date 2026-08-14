/** COC 7th 调查员角色卡相关类型 */

export interface COCAttributes {
  str: number
  con: number
  siz: number
  dex: number
  app: number
  int: number
  pow: number
  edu: number
  luck: number
}

/** 职业技能分配：8 个职业技能 + 信用评级，共 9 个数值：70, 60, 60, 50, 50, 50, 40, 40, 40 */
export const OCCUPATION_SKILL_VALUES = [70, 60, 60, 50, 50, 50, 40, 40, 40] as const

/** 兴趣技能：任选 4 个非职业技能，每个在基础值上 +20% */
export const PERSONAL_INTEREST_BONUS = 20
export const PERSONAL_INTEREST_COUNT = 4

/** 衍生数值：HP/MP/SAN 在游戏中会变化 */
export interface COCDerivedStats {
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  san: number
  sanMax: number
}

/** P0 扩展：疯狂、战斗状态（可选，兼容旧角色卡） */
export type InsanityState = 'normal' | 'temporary' | 'indefinite' | 'permanent'

/** 武器条目（名称、伤害表达式、射程等） */
export interface COCWeapon {
  name: string
  damage?: string
  range?: string
}

export interface COCCharacterSheet {
  occupationId: string
  occupationName: string
  playerName: string
  attributes: COCAttributes
  /** 技能名 -> 百分比 (含职业分配与兴趣+20%，游戏中可能成长) */
  skills: Record<string, number>
  /** 已分配的 9 个职业技能键（含 Credit Rating） */
  occupationSkillKeys: string[]
  /** 已选的 4 个兴趣技能键 */
  personalInterestKeys: string[]
  /** 衍生数值（HP/MP/SAN 可随游戏变化） */
  derived: COCDerivedStats
  /** 战斗：伤害加值（STR+SIZ 表，如 "0","+1D4"） */
  damageBonus?: string
  /** 战斗：体格 -2～6（STR+SIZ 表） */
  build?: number
  /** 移动率（可选，可由属性推算） */
  mov?: number
  /** 护甲减免值 */
  armor?: number
  /** 疯狂状态 */
  insanityState?: InsanityState
  /** 当前恐惧症列表 */
  phobias?: string[]
  /** 当前躁狂症列表 */
  manias?: string[]
  /** 当日累计 SAN 损失（用于不定性疯狂判定） */
  dailySanLoss?: number
  /** 是否处于重伤状态 */
  hasMajorWound?: boolean
  /** 是否濒死（HP=0+重伤，每轮 CON 检定） */
  isDying?: boolean
  /** 武器列表（名称、伤害、射程等） */
  weapons?: COCWeapon[]
}

export type GamePhase =
  | 'story_selected'      // 已选故事，未选职业
  | 'occupation_selected'  // 已选职业，未完成角色卡
  | 'character_ready'      // 角色卡完成，未进入游戏
  | 'playing'              // 游戏中，AI KP 已启动
  | 'ended'                // 游戏已结束，进入结局总结
