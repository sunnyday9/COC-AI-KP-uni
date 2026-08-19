/**
 * COC 7th 角色创建纯逻辑（无 AI）
 */
import type { COCAttributes, COCCharacterSheet, COCDerivedStats } from '../types/character'
import {
  OCCUPATION_SKILL_VALUES,
  PERSONAL_INTEREST_BONUS,
  PERSONAL_INTEREST_COUNT,
} from '../types/character'
import { COC7_SKILLS, rollAllAttributes } from './coc7'

/** 根据职业模板解析后的 9 个技能键（8 职业 + Credit Rating），与 OCCUPATION_SKILL_VALUES 一一对应 */
export function buildOccupationSkills(
  occupationSkillKeys: string[],
  values: readonly number[] = OCCUPATION_SKILL_VALUES
): Record<string, number> {
  const out: Record<string, number> = {}
  const vals = [...values]
  occupationSkillKeys.slice(0, 9).forEach((key, i) => {
    if (key && vals[i] != null) out[key] = vals[i]
  })
  return out
}

/** 兴趣技能：4 个技能在基础值上 +20 */
export function buildPersonalInterestSkills(
  personalInterestKeys: string[]
): Record<string, number> {
  const skillMap = new Map(COC7_SKILLS.map((s) => [s.id, s.base]))
  const out: Record<string, number> = {}
  personalInterestKeys.slice(0, PERSONAL_INTEREST_COUNT).forEach((key) => {
    const base = skillMap.get(key) ?? 0
    out[key] = Math.min(99, base + PERSONAL_INTEREST_BONUS)
  })
  return out
}

/** 合并职业分配与兴趣技能。若同一技能既是职业技能又是兴趣技能，取职业值 + 兴趣加成（+20）。 */
export function mergeSkills(
  occupation: Record<string, number>,
  personalInterest: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = {}
  const allKeys = new Set([...Object.keys(occupation), ...Object.keys(personalInterest)])
  for (const k of allKeys) {
    const occ = occupation[k]
    const pers = personalInterest[k]
    if (occ != null && pers != null) {
      // 职业技能同时选了兴趣加成：职业值 + 兴趣加成（叠加）
      merged[k] = Math.min(99, occ + PERSONAL_INTEREST_BONUS)
    } else if (occ != null) {
      merged[k] = occ
    } else if (pers != null) {
      merged[k] = pers
    }
  }
  return merged
}

/** 投掷全部属性 */
export function rollAttributes(): COCAttributes {
  const r = rollAllAttributes()
  return {
    str: r.str,
    con: r.con,
    siz: r.siz,
    dex: r.dex,
    app: r.app,
    int: r.int,
    pow: r.pow,
    edu: r.edu,
    luck: r.luck,
  }
}

/** 计算衍生技能：母语 = EDU，闪避 = DEX/2 */
export function getDerivedSkillValues(attributes: COCAttributes): Record<string, number> {
  return {
    'Language (Own)': attributes.edu,
    Dodge: Math.floor(attributes.dex / 2),
  }
}

/** 计算 HP/MP/SAN（规则书：HP=(CON+SIZ)/10，MP=POW/5，SAN 初始=POW） */
export function computeDerivedStats(attributes: COCAttributes): COCDerivedStats {
  const hpMax = Math.floor((attributes.con + attributes.siz) / 10)
  const mpMax = Math.floor(attributes.pow / 5)
  const sanMax = attributes.pow
  return {
    hp: hpMax,
    hpMax,
    mp: mpMax,
    mpMax,
    san: sanMax,
    sanMax,
  }
}

/** COC 7th 伤害加值/体格表：STR+SIZ 对应 damageBonus 与 build */
const STR_SIZ_DAMAGE_BUILD: { sumMax: number; damageBonus: string; build: number }[] = [
  { sumMax: 12, damageBonus: '-2', build: -2 },
  { sumMax: 16, damageBonus: '-1', build: -1 },
  { sumMax: 24, damageBonus: '0', build: 0 },
  { sumMax: 32, damageBonus: '+1D4', build: 1 },
  { sumMax: 40, damageBonus: '+1D6', build: 2 },
  { sumMax: 56, damageBonus: '+2D6', build: 3 },
  { sumMax: 72, damageBonus: '+3D6', build: 4 },
  { sumMax: 88, damageBonus: '+4D6', build: 5 },
  { sumMax: 999, damageBonus: '+5D6', build: 6 },
]

/** 根据 STR+SIZ 查表得到伤害加值与体格 */
export function getDamageBonusAndBuild(str: number, siz: number): { damageBonus: string; build: number } {
  const sum = str + siz
  const row = STR_SIZ_DAMAGE_BUILD.find((r) => sum <= r.sumMax)
  return row ? { damageBonus: row.damageBonus, build: row.build } : { damageBonus: '0', build: 0 }
}

/** 生成完整角色卡（职业分配 + 兴趣技能 + 属性 + 衍生） */
export function buildCharacterSheet(
  occupationId: string,
  occupationName: string,
  playerName: string,
  occupationSkillKeys: string[],
  personalInterestKeys: string[],
  attributes: COCAttributes,
  occupationValues: number[] = [...OCCUPATION_SKILL_VALUES]
): COCCharacterSheet {
  const occSkills = buildOccupationSkills(occupationSkillKeys, occupationValues)
  const persSkills = buildPersonalInterestSkills(personalInterestKeys)
  const skills = mergeSkills(occSkills, persSkills)
  const derivedSkills = getDerivedSkillValues(attributes)
  Object.entries(derivedSkills).forEach(([k, v]) => {
    if (skills[k] == null) skills[k] = v
  })
  const derived = computeDerivedStats(attributes)
  const { damageBonus, build } = getDamageBonusAndBuild(attributes.str, attributes.siz)
  return {
    occupationId,
    occupationName,
    playerName,
    attributes,
    skills,
    occupationSkillKeys: occupationSkillKeys.slice(0, 9),
    personalInterestKeys: personalInterestKeys.slice(0, PERSONAL_INTEREST_COUNT),
    derived,
    damageBonus,
    build,
    armor: 0,
    insanityState: 'normal',
    phobias: [],
    manias: [],
    dailySanLoss: 0,
    hasMajorWound: false,
    isDying: false,
    weapons: [],
  }
}

export function getSkillBase(skillId: string): number {
  return COC7_SKILLS.find((s) => s.id === skillId)?.base ?? 0
}
