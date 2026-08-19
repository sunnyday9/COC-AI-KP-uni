import { describe, it, expect } from 'vitest'
import {
  parseScriptContent,
  findScene,
  sceneUnlocked,
  getAvailableClues,
  getSceneNpcs,
  type ScriptContext,
} from '../scriptContext.js'

const STRUCTURED_SCRIPT = {
  meta: { title: '测试剧本', ruleSystem: 'coc' },
  scenes: [
    {
      id: 'scene_001',
      name: '校长办公室',
      npcIds: ['npc_001'],
      clueIds: ['clue_001', 'clue_002'],
      requiredClues: [],
    },
    {
      id: 'scene_002',
      name: '地下室',
      clueIds: ['clue_003'],
      requiredClues: ['clue_001'],
      transitionCondition: '自由文本（被结构化字段覆盖）',
    },
  ],
  clues: [
    { id: 'clue_001', description: '相框里的照片', obtainCondition: '查看办公桌' },
    { id: 'clue_002', description: '账本', requiredClues: ['clue_001'] },
    { id: 'clue_003', description: '仪式书' },
  ],
  npcs: [{ id: 'npc_001', name: '马卡拉', description: '校长' }],
}

describe('parseScriptContent', () => {
  it('parses a structured script', () => {
    const ctx = parseScriptContent(JSON.stringify(STRUCTURED_SCRIPT))
    expect(ctx).not.toBeNull()
    expect(ctx!.scenes).toHaveLength(2)
    expect(ctx!.clues).toHaveLength(3)
    expect(ctx!.npcs).toHaveLength(1)
  })

  it('returns null for non-JSON and non-script JSON', () => {
    expect(parseScriptContent('not json')).toBeNull()
    expect(parseScriptContent('{"foo": 1}')).toBeNull()
    expect(parseScriptContent(JSON.stringify({ meta: {}, scenes: 'nope' }))).toBeNull()
  })

  it('parses a free-text-only (legacy) script without structured gates', () => {
    const ctx = parseScriptContent(
      JSON.stringify({
        meta: { title: '重返黑色校园', ruleSystem: 'coc' },
        scenes: [{ id: 's1', name: '校长办公室', transitionCondition: '完成初步调查' }],
        clues: [{ id: 'c1', description: '照片', obtainCondition: '查看办公桌' }],
      }),
    )
    expect(ctx).not.toBeNull()
    expect(ctx!.scenes[0]!.requiredClues).toBeUndefined()
    expect(ctx!.clues[0]!.requiredClues).toBeUndefined()
  })
})

describe('sceneUnlocked', () => {
  const ctx = parseScriptContent(JSON.stringify(STRUCTURED_SCRIPT)) as ScriptContext
  const office = findScene(ctx, '校长办公室')!
  const basement = findScene(ctx, '地下室')!

  it('open scene → unlocked null (not enforced)', () => {
    expect(sceneUnlocked(office, []).unlocked).toBeNull()
  })

  it('gated scene: locked without the required clue, unlocked with it', () => {
    expect(sceneUnlocked(basement, []).unlocked).toBe(false)
    expect(sceneUnlocked(basement, []).missing).toEqual(['clue_001'])
    expect(sceneUnlocked(basement, ['clue_001']).unlocked).toBe(true)
    expect(sceneUnlocked(basement, ['clue_001']).missing).toEqual([])
  })
})

describe('getAvailableClues', () => {
  const ctx = parseScriptContent(JSON.stringify(STRUCTURED_SCRIPT)) as ScriptContext
  const office = findScene(ctx, '校长办公室')!

  it('lists open clues; respects clue-level prerequisites', () => {
    const none = getAvailableClues(office, [], ctx)
    expect(none.map((x) => x.clue.id)).toEqual(['clue_001']) // clue_002 gated behind clue_001

    // clue_001 already obtained → skipped; clue_002 prerequisites now met.
    const withFirst = getAvailableClues(office, ['clue_001'], ctx)
    expect(withFirst.map((x) => x.clue.id)).toEqual(['clue_002'])
    expect(withFirst[0]!.reason).toBe('unlocked-by-clue')
  })

  it('omits already-obtained clues', () => {
    const r = getAvailableClues(office, ['clue_001', 'clue_002'], ctx)
    expect(r).toHaveLength(0)
  })
})

describe('getSceneNpcs', () => {
  const ctx = parseScriptContent(JSON.stringify(STRUCTURED_SCRIPT)) as ScriptContext
  const basement = findScene(ctx, '地下室')!
  it('maps npcIds to names', () => {
    expect(getSceneNpcs(ctx, basement)).toEqual([])
    const office = findScene(ctx, '校长办公室')!
    const npcs = getSceneNpcs(ctx, office)
    expect(npcs.map((n) => n.name)).toEqual(['马卡拉'])
    expect(npcs[0]!.role).toBe('校长')
  })
})
