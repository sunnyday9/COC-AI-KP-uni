/**
 * 第五章 游戏系统 — 技能检定阈值与结果（规则书符合性）
 */
import { describe, it, expect } from 'vitest'
import {
  resolveSkillCheck,
  SUCCESS_LEVEL_RANK,
  SKILL_CHECK_RESULT_TEXT,
} from '../coc7Rules'

describe('第五章 游戏系统 - 技能检定 resolveSkillCheck', () => {
  describe('阈值：常规=技能值，困难=skill/2，极难=skill/5', () => {
    const skill50 = 50
    it('常规难度 threshold = 50', () => {
      const r = resolveSkillCheck(50, skill50, 'regular')
      expect(r.threshold).toBe(50)
    })
    it('困难难度 threshold = 25', () => {
      const r = resolveSkillCheck(25, skill50, 'hard')
      expect(r.threshold).toBe(25)
    })
    it('极难难度 threshold = 10', () => {
      const r = resolveSkillCheck(10, skill50, 'extreme')
      expect(r.threshold).toBe(10)
    })
    it('技能 80：常规 80，困难 40，极难 16', () => {
      expect(resolveSkillCheck(1, 80, 'regular').threshold).toBe(80)
      expect(resolveSkillCheck(1, 80, 'hard').threshold).toBe(40)
      expect(resolveSkillCheck(1, 80, 'extreme').threshold).toBe(16)
    })
  })

  describe('大成功/大失败边界', () => {
    it('roll=1 必为大成功', () => {
      expect(resolveSkillCheck(1, 50, 'regular').result).toBe('critical_success')
      expect(resolveSkillCheck(1, 80, 'extreme').result).toBe('critical_success')
    })
    it('roll=100 必为大失败', () => {
      expect(resolveSkillCheck(100, 50, 'regular').result).toBe('fumble')
      expect(resolveSkillCheck(100, 80, 'regular').result).toBe('fumble')
    })
    it('skill<50 时 roll>=96 为大失败', () => {
      expect(resolveSkillCheck(96, 49, 'regular').result).toBe('fumble')
      expect(resolveSkillCheck(99, 49, 'regular').result).toBe('fumble')
    })
    it('skill>=50 时仅 roll=100 为大失败，96-99 为失败', () => {
      expect(resolveSkillCheck(96, 50, 'regular').result).toBe('failure')
      expect(resolveSkillCheck(99, 50, 'regular').result).toBe('failure')
    })
  })

  describe('成功等级：extreme < hard < regular', () => {
    const skill60 = 60
    it('roll 12 ≤ extreme(12) → extreme_success', () => {
      expect(resolveSkillCheck(12, skill60, 'regular').result).toBe('extreme_success')
    })
    it('roll 30 ≤ hard(30) → hard_success', () => {
      expect(resolveSkillCheck(30, skill60, 'regular').result).toBe('hard_success')
    })
    it('roll 50 ≤ regular(60) → regular_success', () => {
      expect(resolveSkillCheck(50, skill60, 'regular').result).toBe('regular_success')
    })
    it('roll 65 > regular(60) → failure', () => {
      expect(resolveSkillCheck(65, skill60, 'regular').result).toBe('failure')
    })
  })
})

describe('SUCCESS_LEVEL_RANK 对抗检定比较', () => {
  it('大成功 > 极难 > 困难 > 常规 > 失败 > 大失败', () => {
    const r = SUCCESS_LEVEL_RANK
    expect(r.critical_success ?? 0).toBeGreaterThan(r.extreme_success ?? 0)
    expect(r.extreme_success ?? 0).toBeGreaterThan(r.hard_success ?? 0)
    expect(r.hard_success ?? 0).toBeGreaterThan(r.regular_success ?? 0)
    expect(r.regular_success ?? 0).toBeGreaterThan(r.failure ?? 0)
    expect(r.failure ?? 0).toBeGreaterThan(r.fumble ?? 0)
  })
})

describe('SKILL_CHECK_RESULT_TEXT', () => {
  it('包含六种结果的中文标签', () => {
    expect(SKILL_CHECK_RESULT_TEXT.critical_success).toBe('大成功')
    expect(SKILL_CHECK_RESULT_TEXT.fumble).toBe('大失败')
    expect(SKILL_CHECK_RESULT_TEXT.regular_success).toBe('成功')
  })
})
