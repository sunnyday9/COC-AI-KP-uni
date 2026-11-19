import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetBaseUrlCache } from '../../platform/config'
import { stubUni } from '../../platform/__tests__/uniMock'
import { setToken } from '../../platform/token'
import { useStoryStore } from '../storyStore'

let state: ReturnType<typeof stubUni>['state']

beforeEach(() => {
  state = stubUni().state
  resetBaseUrlCache()
  setActivePinia(createPinia())
  setToken('fictional-story-token')
})

afterEach(() => vi.unstubAllGlobals())

it('loads a second library page on demand and opens the selected story with auth', async () => {
  state.requestResponder = ({ url }) => {
    switch (url) {
      case '/api/stories?limit=50':
        return { statusCode: 200, data: {
          stories: [{ id: 'first.txt', name: 'first.txt' }], nextCursor: 'next_1', canPrepare: false,
        } }
      case '/api/stories?limit=50&cursor=next_1':
        return { statusCode: 200, data: {
          stories: [{ id: '灯塔.txt', name: '灯塔.txt' }], nextCursor: null, canPrepare: false,
        } }
      case '/api/stories/' + encodeURIComponent('灯塔.txt') + '?preview=1':
        return { statusCode: 200, data: { name: '灯塔.txt', content: '虚构调查原文' } }
      default:
        return { statusCode: 404, data: { error: 'Unexpected request' } }
    }
  }

  const store = useStoryStore()
  await store.loadStories()
  expect(store.storyFiles.map((story) => story.id)).toEqual(['first.txt'])
  expect(state.requests).toHaveLength(1)
  expect(store.canPrepare).toBe(false)
  expect(store.nextCursor).toBe('next_1')

  await store.loadMoreStories()
  expect(store.storyFiles.map((story) => story.id)).toEqual(['first.txt', '灯塔.txt'])
  expect(store.nextCursor).toBeNull()
  await store.loadMoreStories()
  expect(state.requests).toHaveLength(2)

  await store.selectStory('灯塔.txt')
  expect(store.selectedStory).toEqual({ id: '灯塔.txt', name: '灯塔.txt', content: '虚构调查原文' })
  expect(state.requests[2].header.Authorization).toBe('Bearer fictional-story-token')
})
