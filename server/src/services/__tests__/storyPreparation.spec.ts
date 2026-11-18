import { afterEach, expect, it, vi } from 'vitest'
import { prepareStory, withStoryMutation } from '../storyPreparation.js'
import { CapacityError, ConflictError } from '../../utils/errors.js'

afterEach(() => vi.unstubAllEnvs())

it('bounds preparation across stories and protects the same story from concurrent deletion', async () => {
  vi.stubEnv('STORY_PREPARATION_WORKERS', '0')
  vi.stubEnv('STORY_PREPARATION_CONCURRENCY', '1')
  const first = { kind: 'index', userId: 1, storyId: 'first', params: { scriptId: 'first' } } as const
  const second = { kind: 'index', userId: 2, storyId: 'second', params: { scriptId: 'second' } } as const
  const outcome = { ok: true, indexed: 1 }
  let finish!: (value: typeof outcome) => void
  const held = new Promise<typeof outcome>((resolve) => { finish = resolve })
  const running = prepareStory(first, () => held)
  try {
    const execute = vi.fn(async () => outcome)
    await expect(prepareStory(second, execute)).rejects.toBeInstanceOf(CapacityError)
    expect(execute).not.toHaveBeenCalled()
    await expect(withStoryMutation(1, 'first', execute)).rejects.toBeInstanceOf(ConflictError)
  } finally {
    finish(outcome)
    await running
  }
  await expect(prepareStory(second, async () => outcome)).resolves.toEqual(outcome)
})
