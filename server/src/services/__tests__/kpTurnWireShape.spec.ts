/**
 * kpTurnWireShape 单源纯函数测试（票 #75）。
 *
 * truncate/summarize 决定「LLM 实际看到的 tool 结果 wire」——线上 runKpTurn 与
 * 离线 distill replay 共用同一实现，这里的断言是 wire 形态的行为锚：阈值
 * （8/600/120）与【结果摘要】格式是 SFT 训练数据形状的一部分，改动即线上/离线
 * 同时漂移，需评审。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_RESULT_SUMMARY_CHARS,
  summarizeToolResult,
  truncateToolResult,
} from '../kpTurnWireShape.js'

describe('kpTurnWireShape 阈值契约', () => {
  it('8/600/120 是 wire 契约值：改动 = 线上/离线 wire 形态同时变化', () => {
    expect(MAX_TOOL_ITERATIONS).toBe(8)
    expect(MAX_TOOL_RESULT_CHARS).toBe(600)
    expect(MAX_TOOL_RESULT_SUMMARY_CHARS).toBe(120)
  })
})

describe('truncateToolResult', () => {
  it('阈值内原样返回（恰好压线不截）', () => {
    expect(truncateToolResult('{"ok":1}')).toBe('{"ok":1}')
    expect(truncateToolResult('x'.repeat(MAX_TOOL_RESULT_CHARS))).toHaveLength(MAX_TOOL_RESULT_CHARS)
  })

  it('超阈值截头 + 截断标记', () => {
    expect(truncateToolResult('x'.repeat(MAX_TOOL_RESULT_CHARS + 1))).toBe(
      `${'x'.repeat(MAX_TOOL_RESULT_CHARS)}\n…(truncated)`,
    )
  })
})

describe('summarizeToolResult', () => {
  it('JSON 对象 → 【结果摘要】头（键序保持，尾随换行）', () => {
    expect(summarizeToolResult('{"success":true,"skillName":"侦查","roll":30}')).toBe(
      '【结果摘要】success: true；skillName: 侦查；roll: 30\n',
    )
  })

  it('跳过 null/空串值；嵌套值 stringify', () => {
    expect(summarizeToolResult('{"a":1,"b":null,"c":"","detail":{"x":2}}')).toBe(
      '【结果摘要】a: 1；detail: {"x":2}\n',
    )
  })

  it('各值截 40 字符；最多取 6 对', () => {
    expect(summarizeToolResult(JSON.stringify({ note: '长'.repeat(50) }))).toBe(
      `【结果摘要】note: ${'长'.repeat(40)}\n`,
    )
    const many: Record<string, number> = {}
    for (let i = 1; i <= 8; i++) many[`k${i}`] = i
    expect(summarizeToolResult(JSON.stringify(many))).toBe('【结果摘要】k1: 1；k2: 2；k3: 3；k4: 4；k5: 5；k6: 6\n')
  })

  it('摘要头超限：截 120 字符 + …', () => {
    const out = summarizeToolResult(
      JSON.stringify({ k1: 'v'.repeat(40), k2: 'v'.repeat(40), k3: 'v'.repeat(40), k4: 'v'.repeat(40) }),
    )
    expect(out.startsWith('【结果摘要】k1: ')).toBe(true)
    expect(out.endsWith('…\n')).toBe(true)
    expect(out.length).toBe(MAX_TOOL_RESULT_SUMMARY_CHARS + 2)
  })

  it('非 JSON / JSON 原始类型 → 无摘要头', () => {
    expect(summarizeToolResult('error: missing skillName')).toBe('')
    expect(summarizeToolResult('42')).toBe('')
    expect(summarizeToolResult('null')).toBe('')
  })
})
