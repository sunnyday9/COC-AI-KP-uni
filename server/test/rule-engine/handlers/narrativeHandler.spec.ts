/**
 * 叙事工具 — 场景转换、线索授予
 * 迁自 client/src/toolCalling/handlers/__tests__/narrativeHandler.spec.ts（Phase A1 规则引擎下沉）
 */
import { describe, it, expect } from 'vitest'
import { narrativeHandler } from '../../../src/rule-engine/handlers/narrativeHandler.js'
import { createMockContext } from '../mockContext.js'

describe('narrativeHandler transition_scene', () => {
  it('调用 transitionToScene 并返回成功', () => {
    let sceneName = ''
    const ctx = createMockContext({ onTransitionScene: (n) => { sceneName = n } })
    const r = narrativeHandler.handle('transition_scene', { sceneName: '图书馆' }, ctx)
    expect(sceneName).toBe('图书馆')
    expect(r.content).toContain('Scene transitioned')
    expect(r.displayMessages.length).toBe(1)
  })

  it('sceneName 为空时返回 error', () => {
    const ctx = createMockContext()
    const r = narrativeHandler.handle('transition_scene', { sceneName: '' }, ctx)
    expect(r.content).toContain('error')
    expect(r.displayMessages.length).toBe(0)
  })

  it('server-side story guard rejects a locked transition before room mutation', () => {
    let sceneName = ''
    const ctx = createMockContext({
      onTransitionScene: (name) => { sceneName = name },
      resolveNarrativeToolCall: () => ({ error: 'condition is ambiguous; keep locked' }),
    })

    const result = narrativeHandler.handle('transition_scene', { sceneName: '地下室' }, ctx)

    expect(sceneName).toBe('')
    expect(result.content).toContain('condition is ambiguous')
    expect(result.displayMessages).toHaveLength(0)
  })
})

describe('narrativeHandler grant_clue', () => {
  it('调用 addClue 并返回成功', () => {
    let clueDesc = ''
    const ctx = createMockContext({ onAddClue: (d) => { clueDesc = d } })
    const r = narrativeHandler.handle('grant_clue', { description: '桌上有一本日记' }, ctx)
    expect(clueDesc).toBe('桌上有一本日记')
    expect(r.content).toContain('Clue granted')
  })

  it('description 为空时返回 error: description required', () => {
    const ctx = createMockContext()
    const r = narrativeHandler.handle('grant_clue', { description: '' }, ctx)
    expect(r.content).toContain('error')
    expect(r.content).toContain('description required')
    expect(r.displayMessages).toHaveLength(0)
  })

  it('uses the canonical scripted clue ID returned by the server-side story resolver', () => {
    let granted: { description: string; clueId?: string } | null = null
    const ctx = createMockContext({
      onAddClue: (description, clueId) => { granted = { description, clueId } },
      resolveNarrativeToolCall: () => ({ args: { description: '值班记录', clueId: 'note' } }),
    })

    const result = narrativeHandler.handle('grant_clue', { description: '值班记录' }, ctx)

    expect(granted).toEqual({ description: '值班记录', clueId: 'note' })
    expect(result.content).toContain('Clue granted')
  })
})

describe('narrativeHandler unknown tool', () => {
  it('非 transition_scene/grant_clue 时返回 error: unknown tool', () => {
    const ctx = createMockContext()
    const r = narrativeHandler.handle('other_tool', {}, ctx)
    expect(r.content).toBe('error: unknown tool')
    expect(r.displayMessages).toHaveLength(0)
  })
})
