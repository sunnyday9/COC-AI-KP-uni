import { describe, expect, it } from 'vitest'
import { classifySystemMessage } from './classifySystemMessage'
import type { Message } from '../../../shared/types/game'

function sys(content: string): Message {
  return { id: 'm', timestamp: 1, role: 'system', content }
}

describe('classifySystemMessage（T4 消息类型体系）', () => {
  it('HP ±N → damage（战斗伤害血色调）', () => {
    expect(classifySystemMessage(sys('HP -2'))).toBe('damage')
    expect(classifySystemMessage(sys('HP +1'))).toBe('damage')
  })

  it('SAN/MP ±N → stat（属性变更）', () => {
    expect(classifySystemMessage(sys('SAN -5'))).toBe('stat')
    expect(classifySystemMessage(sys('SAN +3'))).toBe('stat')
    expect(classifySystemMessage(sys('MP -2'))).toBe('stat')
  })

  it('场景切换前缀 → scene（场景分隔卡）', () => {
    expect(classifySystemMessage(sys('场景切换: 图书馆'))).toBe('scene')
  })

  it('获得线索前缀 → clue（线索绿光条）', () => {
    expect(classifySystemMessage(sys('获得线索: 书架后的暗格里藏着一把铜钥匙'))).toBe('clue')
  })

  it('含检定/d100/dN 数字段 → dice（掷骰卡）', () => {
    expect(classifySystemMessage(sys('侦查检定(常规) d100: 45 / 目标≤60 → 成功'))).toBe('dice')
    expect(classifySystemMessage(sys('投骰 d6: 4'))).toBe('dice')
    expect(classifySystemMessage(sys('近战: A vs B → A胜'))).toBe('dice') // 对抗掷骰（d100: 段缺失仍识别）
    expect(classifySystemMessage(sys('SAN检定 d100: 30 / 目标≤65 → 成功'))).toBe('dice')
    expect(classifySystemMessage(sys('消耗幸运 5，当前幸运: 55'))).toBe('generic')
  })

  it('无形态匹配 → generic', () => {
    expect(classifySystemMessage(sys('新的一天开始，当日 SAN 损失已重置'))).toBe('generic')
    expect(classifySystemMessage(sys('KP 回合失败，请稍后重试。'))).toBe('generic')
  })

  it('空 content → generic', () => {
    expect(classifySystemMessage(sys(''))).toBe('generic')
  })

  it('dice 判定落在 stat 前缀之前不误伤（完整 e2e 消息走 dice）', () => {
    // e2e 步骤 11 完整序列：投骰 d6: N 为纯掷骰（无 target），战斗随后 HP -2 独立 damage
    expect(classifySystemMessage(sys('投骰 d6: 4'))).toBe('dice')
  })

  it('结构化字段优先：type:dice + result.target 直判 dice（与文本形态无关，#79）', () => {
    const m: Message = { id: 'm', timestamp: 1, role: 'system', type: 'dice', content: '侦查检定(常规) d100: 45 / 目标≤60 → 成功', result: { roll: 45, target: 60 } }
    expect(classifySystemMessage(m)).toBe('dice')
    // 字段优先的直接证明：content 不匹配任何骰子文本形态，仍按结构化事实判 dice
    const m2: Message = { id: 'm2', timestamp: 1, role: 'system', type: 'dice', content: '（结构化检定事实）', result: { roll: 45, target: 60 } }
    expect(classifySystemMessage(m2)).toBe('dice')
  })

  it('type:dice 无 result.target（SAN 损失/大失败惩罚形状）→ 走文本兜底判 generic（等价性钉住，#79）', () => {
    // 服务端 sanityHandler 现产形状：type:'dice' + result:{roll} 无 target，今日显示为 generic
    const m: Message = { id: 'm', timestamp: 1, role: 'system', type: 'dice', content: 'SAN损失检定 1d4+1: 3', result: { roll: 3 } }
    expect(classifySystemMessage(m)).toBe('generic')
    // 环境伤害形状：type:'dice' 无 result，content 带 d100 段 → 文本兜底判 dice
    const m2: Message = { id: 'm2', timestamp: 1, role: 'system', type: 'dice', content: '溺水: CON 检定 d100:42 > 50 失败 → 受到 3 点伤害' }
    expect(classifySystemMessage(m2)).toBe('dice')
  })

  it('旧快照无 type/result → 文本正则兜底路径不变（#79）', () => {
    expect(classifySystemMessage(sys('灵感检定 d100: 12 / 目标≤40 → 失败（无论成败线索都会给出）'))).toBe('dice')
    expect(classifySystemMessage(sys('远程: 射击检定 d100:88 → 未中'))).toBe('dice')
    expect(classifySystemMessage(sys('坠落伤害(轻微) → 3 点'))).toBe('generic')
  })
})
