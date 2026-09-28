import { describe, expect, it, vi } from 'vitest'

const loadScriptContextMock = vi.hoisted(() => vi.fn())

vi.mock('../scriptContext.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scriptContext.js')>(),
  loadScriptContext: loadScriptContextMock,
}))

import { createKPGraph, type KpMessage } from '../kpGraph.js'
import { loadScriptContext, parseScriptContent } from '../scriptContext.js'

describe('KP free-text condition explanations', () => {
  it('explains and refuses a scene transition whose condition is ambiguous', async () => {
    vi.mocked(loadScriptContext).mockResolvedValue(parseScriptContent(JSON.stringify({
      scenes: [
        { id: 'office', name: '校长办公室' },
        { id: 'basement', name: '地下室', transitionCondition: '完成初步调查后' },
      ],
      clues: [],
    })))

    const graph = createKPGraph(async (_messages: KpMessage[]) => ({ content: '暂时无法进入。' }), 1)
    const result = await graph.invoke({
      messages: [
        { role: 'system', content: '测试' },
        { role: 'user', content: '我前往地下室' },
      ],
      storyContext: { scriptId: 'condition-test', sceneName: '校长办公室', openClues: [], forceTransitionScene: '地下室' },
    }) as Record<string, unknown>

    expect(result.toolPlan).toContain('条件无法安全判定')
    expect(result.toolPlan).toContain('暂时锁定')
    expect(result.toolPlan).toContain('向玩家解释')
    expect(result.requiredTools).not.toContain('transition_scene')
  })

  it('explains why a clue with an ambiguous obtain condition must stay locked', async () => {
    vi.mocked(loadScriptContext).mockResolvedValue(parseScriptContent(JSON.stringify({
      scenes: [{ id: 'office', name: '校长办公室', clueIds: ['photo'] }],
      clues: [{ id: 'photo', description: '相框里的照片', obtainCondition: '检查完房间后' }],
    })))

    const graph = createKPGraph(async (_messages: KpMessage[]) => ({ content: '你仔细查看桌面。' }), 1)
    const result = await graph.invoke({
      messages: [
        { role: 'system', content: '测试' },
        { role: 'user', content: '我搜索桌面' },
      ],
      storyContext: { scriptId: 'condition-test', sceneName: '校长办公室', openClues: [] },
    }) as Record<string, unknown>

    expect(result.toolPlan).toContain('相框里的照片')
    expect(result.toolPlan).toContain('无法安全判定')
    expect(result.toolPlan).toContain('不要调用 grant_clue')
    expect(result.toolPlan).toContain('向玩家解释')
  })

  it('loads script gating data from the persisted story owner after room handoff', async () => {
    vi.mocked(loadScriptContext).mockClear()
    vi.mocked(loadScriptContext).mockResolvedValue(parseScriptContent(JSON.stringify({
      scenes: [{ id: 'office', name: '校长办公室' }],
      clues: [],
    })))

    const graph = createKPGraph(async (_messages: KpMessage[]) => ({ content: '你检查了一下门口。' }), 1)
    await graph.invoke({
      messages: [
        { role: 'system', content: '测试' },
        { role: 'user', content: '我检查一下门口' },
      ],
      storyContext: { scriptId: 'handoff-story', storyOwnerId: 70001, sceneName: '校长办公室', openClues: [] },
    })

    expect(loadScriptContext).toHaveBeenCalledWith(70001, 'handoff-story')
  })
})
