import { describe, it, expect } from 'vitest'
import { parseActionOptions, shouldParseOptions } from './parseActionOptions'

/**
 * 契约 = 原 KPMessage.vue 内联解析行为（#27 项 5 抽 util 时逐字保持一致）：
 * - 引导头无冒号写法（「可选行动」/「【可选行动】」后直接换行）→ 头分支，正文剥离头；
 * - 「可选行动：」带冒号写法匹配头正则失败（分支 1 无冒号）→ 走尾部裸列表回退，
 *   正文保留引导头行 —— 与旧实现一致。
 */
describe('parseActionOptions（#27 项 5：KPMessage 解析契约抽 util）', () => {
  it('头分支：裸头「可选行动」+ 列表 → 选项剥离，正文干净', () => {
    const r = parseActionOptions('你推开门。\n可选行动\n- 侦查房间\n- 转身离开', 'kp')
    expect(r.text).toBe('你推开门。')
    expect(r.options).toEqual(['侦查房间', '转身离开'])
  })

  it('头分支：【可选行动】带括号写法', () => {
    const r = parseActionOptions('门缝透出微光。\n【可选行动】\n- 推门\n- 倾听', 'kp')
    expect(r.text).toBe('门缝透出微光。')
    expect(r.options).toEqual(['推门', '倾听'])
  })

  it('头分支：中文标点引导头变体', () => {
    expect(parseActionOptions('你可以选择：\n1. 前进\n2. 后退', 'kp').options).toEqual(['前进', '后退'])
    expect(parseActionOptions('接下来你打算怎么做？\n1. 前进', 'kp').options).toEqual(['前进'])
    expect(parseActionOptions('你的选择：\n1. 前进', 'kp').options).toEqual(['前进'])
  })

  it('头分支：选项列表后的尾随文字拼回正文', () => {
    const r = parseActionOptions('你听到低语。\n【可选行动】\n- 聆听\n（低语渐弱）', 'kp')
    expect(r.text).toBe('你听到低语。\n\n（低语渐弱）')
    expect(r.options).toEqual(['聆听'])
  })

  it('冒号头写法（可选行动：）→ 尾部裸列表回退解析，正文保留引导头行（旧行为一致）', () => {
    const r = parseActionOptions('你推开门。\n可选行动：\n- 侦查房间\n- 转身离开', 'kp')
    expect(r.options).toEqual(['侦查房间', '转身离开'])
    expect(r.text).toBe('你推开门。\n可选行动：')
  })

  it('去 markdown 粗体与行首符号', () => {
    const r = parseActionOptions('你环顾四周。\n【可选行动】\n- **调查**书架\n- 逃跑', 'kp')
    expect(r.options).toEqual(['调查书架', '逃跑'])
    expect(r.text).toBe('你环顾四周。')
  })

  it('尾部裸列表（无引导头）回退解析', () => {
    const r = parseActionOptions('风声灌入房间。\n1. 关窗\n2. 拉上窗帘', 'kp')
    expect(r.text).toBe('风声灌入房间。')
    expect(r.options).toEqual(['关窗', '拉上窗帘'])
  })

  it('选项数 0 或 >6 → 原样返回无选项', () => {
    const noList = parseActionOptions('你环顾四周，一片寂静。', 'kp')
    expect(noList.options).toEqual([])
    expect(noList.text).toBe('你环顾四周，一片寂静。')
    const long = parseActionOptions('可选行动\n' + Array.from({ length: 7 }, (_, i) => `- 选项${i + 1}`).join('\n'), 'kp')
    expect(long.options).toEqual([])
    expect(long.text).toContain('可选行动')
  })

  it('非 kp 角色不解析', () => {
    const r = parseActionOptions('可选行动\n- 侦查', 'player')
    expect(r.options).toEqual([])
    expect(r.text).toBe('可选行动\n- 侦查')
  })

  it('shouldParseOptions：仅 kp 且非流式', () => {
    expect(shouldParseOptions({ role: 'kp', isStreaming: false })).toBe(true)
    expect(shouldParseOptions({ role: 'kp', isStreaming: true })).toBe(false)
    expect(shouldParseOptions({ role: 'player', isStreaming: false })).toBe(false)
  })
})
