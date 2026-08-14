/**
 * 叙事工具 — 场景转换、线索授予
 */
import { describe, it, expect } from 'vitest'
import { narrativeHandler } from '../narrativeHandler'
import { createMockContext } from '../../__tests__/mockContext'

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
})

describe('narrativeHandler unknown tool', () => {
  it('非 transition_scene/grant_clue 时返回 error: unknown tool', () => {
    const ctx = createMockContext()
    const r = narrativeHandler.handle('other_tool', {}, ctx)
    expect(r.content).toBe('error: unknown tool')
    expect(r.displayMessages).toHaveLength(0)
  })
})
