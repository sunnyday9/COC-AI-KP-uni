import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetBaseUrlCache } from '../../platform/config'
import { stubUni } from '../../platform/__tests__/uniMock'
import { setToken } from '../../platform/token'
import { useStoryStore } from '../storyStore'
import type { StoryPreparationStatus } from '../../../../shared/types/bridge'

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

it('shows durable preparation on reload and updates the same story when its job completes', async () => {
  const running = { activeRevision: null, job: { id: 'job-1', version: '1', state: 'running', stage: 'dossier', percent: 52 } }
  const complete = { activeRevision: 'revision-1', job: { id: 'job-1', version: '2', state: 'complete', stage: 'complete', percent: 100 } }
  state.requestResponder = ({ url, method }) => {
    if (method === 'GET' && url === '/api/stories?limit=50') {
      return { statusCode: 200, data: {
        stories: [{ id: 'first.txt', name: 'first.txt', preparation: running }],
        nextCursor: null, canPrepare: true, preparationMode: 'durable',
      } }
    }
    if (method === 'GET' && url === '/api/stories/first.txt/preparation') return { statusCode: 200, data: complete }
    return { statusCode: 404, data: { error: 'Unexpected request' } }
  }

  const store = useStoryStore()
  await store.loadStories()
  expect(store.preparationMode).toBe('durable')
  expect(store.storyFiles[0].preparation).toEqual(running)

  await store.refreshStoryPreparation('first.txt')
  expect(store.storyFiles[0].preparation).toEqual(complete)
})

it.each(['load more', 'reload before enqueue resolves', 'reload after enqueue resolves'])(
  'preserves the newest preparation state during %s',
  async (overlap) => {
    const idle: StoryPreparationStatus = { activeRevision: null, job: null }
    const queued: StoryPreparationStatus = {
      activeRevision: null, job: { id: 'job-1', version: '9', state: 'queued', stage: 'queued', percent: 0 },
    }
    const running: StoryPreparationStatus = {
      activeRevision: null, job: { id: 'job-1', version: '10', state: 'running', stage: 'index', percent: 20 },
    }
    let snapshot = idle
    let finishList: (() => void) | undefined
    let finishSubmit: (() => void) | undefined
    const original = { id: 'first.txt', name: 'first.txt' }
    state.requestResponder = ({ method, url }) => {
      if (method === 'POST') {
        return new Promise((resolve) => { finishSubmit = () => resolve({ statusCode: 202, data: queued }) })
      }
      const nextPage = url.includes('cursor=')
      const reply = { statusCode: 200, data: {
        stories: nextPage
          ? [{ id: 'second.txt', name: 'second.txt' }]
          : [{ ...original, preparation: snapshot }],
        nextCursor: nextPage ? null : 'next_1', canPrepare: true, preparationMode: 'durable',
      } }
      if (!finishSubmit) return reply
      return new Promise((resolve) => { finishList = () => resolve(reply) })
    }
    const storyStore = useStoryStore()
    await storyStore.loadStories()
    const submit = storyStore.submitStoryPreparation('first.txt')
    if (overlap === 'reload before enqueue resolves') snapshot = running
    const list = overlap === 'load more' ? storyStore.loadMoreStories() : storyStore.loadStories()
    if (overlap === 'reload before enqueue resolves') {
      finishList!()
      await list
      finishSubmit!()
      await submit
    } else {
      finishSubmit!()
      await submit
      finishList!()
      await list
    }
    expect(storyStore.storyFiles[0].preparation).toEqual(overlap === 'reload before enqueue resolves' ? running : queued)
  },
)

it('reuses an uncertain operation and applies explicit cancellation and retry results', async () => {
  const route = '/api/stories/first.txt/preparation'
  const idle = { activeRevision: 'previous-revision', job: null }
  const queued = { ...idle, job: { id: 'initial-job', version: '1', state: 'queued', stage: 'queued', percent: 0 } }
  const cancelled = { ...idle, job: { id: 'initial-job', version: '2', state: 'cancelled', stage: 'cancelled', percent: 0 } }
  const retried = { ...idle, job: { ...queued.job, id: 'new-job', version: '3' } }
  state.requestResponder = ({ method, url }) => {
    if (method === 'GET') return { statusCode: 200, data: {
      stories: [{ id: 'first.txt', name: 'first.txt', preparation: idle }],
      nextCursor: null, canPrepare: true, preparationMode: 'durable',
    } }
    if (url === route) return { statusCode: 202, data: queued }
    if (url === route + '/initial-job/cancel') return { statusCode: 200, data: cancelled }
    if (url === route + '/initial-job/retry') return { statusCode: 202, data: retried }
    return { statusCode: 404, data: { error: 'Unexpected request' } }
  }
  const store = useStoryStore()
  await store.loadStories()
  state.failNextRequest = { errMsg: 'fixture network failure after sending' }
  await expect(store.submitStoryPreparation('first.txt')).rejects.toThrow('网络错误')
  await store.submitStoryPreparation('first.txt')
  expect(state.requests[1].data).toEqual({ operationId: expect.any(String) })
  expect(state.requests[2].data).toEqual(state.requests[1].data)
  await store.cancelStoryPreparation('first.txt', 'initial-job')
  expect(store.storyFiles[0].preparation).toEqual(cancelled)
  await store.submitStoryPreparation('first.txt', 'initial-job')
  expect(state.requests[4].data).toEqual({ operationId: expect.any(String) })
  expect(state.requests[4].data).not.toEqual(state.requests[1].data)
  expect(store.storyFiles[0].preparation).toEqual(retried)
})
