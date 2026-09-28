import { describe, expect, it } from 'vitest'
import { getAvailableClues, getBlockedClues, parseScriptContent, sceneUnlocked, type ScriptScene } from '../scriptContext.js'

describe('free-text scene conditions', () => {
  it('normalizes the documented requires_clues format into a deterministic gate', () => {
    const scene: ScriptScene = {
      id: 'archive',
      name: '档案室',
      transitionCondition: 'requires_clues: key, letter',
    }

    expect(sceneUnlocked(scene, [])).toMatchObject({ unlocked: false, missing: ['key', 'letter'] })
    expect(sceneUnlocked(scene, ['key'])).toMatchObject({ unlocked: false, missing: ['letter'] })
    expect(sceneUnlocked(scene, ['key', 'letter'])).toMatchObject({ unlocked: true, missing: [] })
  })

  it('fails closed for unsupported or unknown free-text conditions', () => {
    const ctx = parseScriptContent(JSON.stringify({
      scenes: [],
      clues: [{ id: 'key', description: 'archive key' }],
    }))!

    expect(sceneUnlocked({ id: 'a', name: 'A', transitionCondition: 'when the keeper decides' }, [], ctx))
      .toMatchObject({ unlocked: false, missing: [], reason: 'ambiguous-condition' })
    expect(sceneUnlocked({ id: 'b', name: 'B', transitionCondition: 'requires_clues: typo' }, [], ctx))
      .toMatchObject({ unlocked: false, missing: ['typo'], reason: 'unknown-clue' })
  })

  it('locks ambiguous clue conditions, explains blockers, and keeps structured gates authoritative', () => {
    const ctx = parseScriptContent(JSON.stringify({
      scenes: [{ id: 'study', name: 'Study', clueIds: ['key', 'badge', 'invalid', 'ambiguous', 'structured'] }],
      clues: [
        { id: 'key', description: 'Archive key', obtainCondition: 'requires_clues: badge' },
        { id: 'badge', description: 'Keeper badge' },
        { id: 'invalid', description: 'Misconfigured clue', obtainCondition: 'requires_clues: missing_id' },
        { id: 'ambiguous', description: 'Riddle clue', obtainCondition: 'solve the keeper’s riddle' },
        { id: 'structured', description: 'Structured clue', requiredClues: ['badge'], obtainCondition: 'legacy prose is ignored' },
      ],
    }))!
    const study = ctx.scenes[0]!

    expect(getAvailableClues(study, [], ctx).map(({ clue }) => clue.id)).toEqual(['badge'])
    expect(getBlockedClues(study, [], ctx).map(({ clue, reason, missing }) => ({ id: clue.id, reason, missing }))).toEqual([
      { id: 'key', reason: 'missing-clues', missing: ['badge'] },
      { id: 'invalid', reason: 'unknown-clue', missing: ['missing_id'] },
      { id: 'ambiguous', reason: 'ambiguous-condition', missing: [] },
      { id: 'structured', reason: 'missing-clues', missing: ['badge'] },
    ])

    expect(getAvailableClues(study, ['badge'], ctx).map(({ clue }) => clue.id)).toEqual(['key', 'structured'])
    expect(sceneUnlocked({ id: 'legacy', name: 'Legacy', requiredClues: ['badge'], transitionCondition: 'legacy prose' }, ['badge'], ctx))
      .toMatchObject({ unlocked: true, missing: [] })
  })
})
