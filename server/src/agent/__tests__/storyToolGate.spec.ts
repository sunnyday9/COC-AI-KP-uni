import { describe, expect, it } from 'vitest'
import { parseScriptContent } from '../scriptContext.js'
import { resolveStoryToolCall } from '../storyToolGate.js'

function contextFrom(value: unknown) {
  return parseScriptContent(JSON.stringify(value))!
}

describe('server-side story tool gate', () => {
  it('rejects transitions with ambiguous or unmet conditions', () => {
    const ctx = contextFrom({
      scenes: [
        { id: 'office', name: '办公室' },
        { id: 'basement', name: '地下室', transitionCondition: '调查完成后' },
        { id: 'archive', name: '档案室', transitionCondition: 'requires_clues: key' },
      ],
      clues: [{ id: 'key', description: '铜钥匙' }],
    })

    expect(resolveStoryToolCall('transition_scene', { sceneName: '地下室' }, ctx, []))
      .toMatchObject({ error: expect.stringContaining('ambiguous') })
    expect(resolveStoryToolCall('transition_scene', { sceneName: '档案室' }, ctx, []))
      .toMatchObject({ error: expect.stringContaining('铜钥匙') })
  })

  it('canonicalizes a valid scene transition after its prerequisites are met', () => {
    const ctx = contextFrom({
      scenes: [{ id: 'archive', name: '档案室', transitionCondition: 'requires_clues: key' }],
      clues: [{ id: 'key', description: '铜钥匙' }],
    })

    expect(resolveStoryToolCall('transition_scene', { sceneName: '我去档案室' }, ctx, ['key']))
      .toEqual({ args: { sceneName: '档案室' } })
  })

  it('allows remaining in the current scene, but refuses a clue assigned to another scene', () => {
    const ctx = contextFrom({
      scenes: [
        { id: 'office', name: '办公室', transitionCondition: 'ambiguous legacy text', clueIds: ['office_note'] },
        { id: 'archive', name: '档案室', clueIds: ['archive_key'] },
      ],
      clues: [
        { id: 'office_note', description: '桌上的便条' },
        { id: 'archive_key', description: '档案室钥匙' },
      ],
    })

    expect(resolveStoryToolCall('transition_scene', { sceneName: '办公室' }, ctx, [], 'office'))
      .toEqual({ args: { sceneName: '办公室' } })
    expect(resolveStoryToolCall('grant_clue', { clueId: 'archive_key', description: '档案室钥匙' }, ctx, [], 'office'))
      .toMatchObject({ error: expect.stringContaining('not listed in the current scene') })
  })

  it('rejects locked clue grants and adds the script clue ID when a valid clue is named by description', () => {
    const ctx = contextFrom({
      scenes: [{ id: 'office', name: '办公室' }],
      clues: [
        { id: 'key', description: '铜钥匙', obtainCondition: 'requires_clues: note' },
        { id: 'note', description: '值班记录' },
        { id: 'photo', description: '相框里的照片', obtainCondition: '完成房间调查' },
      ],
    })

    expect(resolveStoryToolCall('grant_clue', { description: '铜钥匙' }, ctx, []))
      .toMatchObject({ error: expect.stringContaining('值班记录') })
    expect(resolveStoryToolCall('grant_clue', { description: '相框里的照片' }, ctx, []))
      .toMatchObject({ error: expect.stringContaining('ambiguous') })
    expect(resolveStoryToolCall('grant_clue', { description: '值班记录' }, ctx, []))
      .toEqual({ args: { description: '值班记录', clueId: 'note' } })
  })

  it('preserves unstructured story tool calls that do not target a known scripted condition', () => {
    const ctx = contextFrom({ scenes: [{ id: 'office', name: '办公室' }], clues: [] })

    expect(resolveStoryToolCall('transition_scene', { sceneName: '临时地点' }, ctx, []))
      .toBeNull()
    expect(resolveStoryToolCall('grant_clue', { description: '临时发现' }, ctx, []))
      .toBeNull()
  })
})
