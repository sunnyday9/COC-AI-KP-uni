/**
 * 集成测试 — 编排器多工具调用与未知工具
 */
import { describe, it, expect } from 'vitest'
import { processToolCalls } from '../orchestrator'
import { createMockContext } from './mockContext'

describe('orchestrator processToolCalls', () => {
  it('单次 skill_check 返回一条 toolResult 与骰子 displayMessage', () => {
    const ctx = createMockContext({ rollSequence: [25] })
    const toolCalls = [
      { id: 'tc1', name: 'skill_check', arguments: JSON.stringify({ skillName: '侦查', skillValue: 50, difficulty: 'regular' }) },
    ]
    const r = processToolCalls(toolCalls, ctx)
    expect(r.toolResults).toHaveLength(1)
    const first = r.toolResults[0]
    expect(first).toBeDefined()
    expect(first!.role).toBe('tool')
    expect(first!.tool_call_id).toBe('tc1')
    const content = JSON.parse(first!.content)
    expect(content.roll).toBe(25)
    expect(content.success).toBe(true)
    expect(r.displayMessages.length).toBeGreaterThanOrEqual(1)
  })

  it('skill_check + adjust_hp 返回两条 toolResults', () => {
    const toolCalls = [
      { id: 'a', name: 'skill_check', arguments: JSON.stringify({ skillName: '急救', skillValue: 50, difficulty: 'regular' }) },
      { id: 'b', name: 'adjust_hp', arguments: JSON.stringify({ delta: 1 }) },
    ]
    let hpDelta = 0
    const ctx2 = createMockContext({ rollSequence: [30], onUpdateHP: (d) => { hpDelta = d } })
    const r = processToolCalls(toolCalls, ctx2)
    expect(r.toolResults).toHaveLength(2)
    expect(r.toolResults[1]!.content).toContain('HP')
    expect(hpDelta).toBe(1)
  })

  it('未知工具名返回 error: unknown tool 且不崩溃', () => {
    const ctx = createMockContext()
    const toolCalls = [
      { id: 'x', name: 'nonexistent_tool', arguments: '{}' },
    ]
    const r = processToolCalls(toolCalls, ctx)
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0]!.content).toContain('error')
    expect(r.toolResults[0]!.content).toContain('nonexistent_tool')
    expect(r.displayMessages).toHaveLength(0)
  })

  it('arguments 非合法 JSON 时 catch 后返回 error: 原因', () => {
    const ctx = createMockContext()
    const toolCalls = [
      { id: 't1', name: 'skill_check', arguments: 'not json' },
    ]
    const r = processToolCalls(toolCalls, ctx)
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0]!.content).toMatch(/^error: /)
    expect(r.displayMessages).toHaveLength(0)
  })
})
