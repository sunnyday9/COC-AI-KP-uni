import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  onLoad: undefined as (() => void) | undefined,
  listPage: vi.fn(),
  roomStart: vi.fn(),
}))

vi.mock('@dcloudio/uni-app', () => ({ onLoad: (callback: () => void) => { fixture.onLoad = callback } }))
vi.mock('../../../stores/roomStore', () => ({
  useRoomStore: () => ({
    roomId: 'room-1',
    phase: 'lobby',
    isOwner: true,
    members: [{ userId: 1, username: 'Test owner', characterId: 'bound-1', role: 'owner' }],
    messages: [],
    storyId: null,
    joinRoom: vi.fn(),
  }),
}))
vi.mock('../../../platform', () => ({
  getBridge: () => ({
    ragListStoryPage: fixture.listPage,
    ragListStories: vi.fn().mockResolvedValue([]),
    roomStart: fixture.roomStart,
    characterList: vi.fn().mockResolvedValue([]),
  }),
}))

import RoomPage from './room.vue'

it('lets a room owner load and start with a ready story from the second page', async () => {
  fixture.listPage
    .mockResolvedValueOnce({ stories: [{ storyId: 'first.txt', name: 'First story', chunkCount: 3 }], nextCursor: 'next' })
    .mockResolvedValueOnce({ stories: [{ storyId: 'second.txt', name: 'Second story', chunkCount: 4 }], nextCursor: null })
  fixture.roomStart.mockResolvedValue({})
  vi.stubGlobal('getCurrentPages', () => [{ options: { roomId: 'room-1' } }])
  const page = mount(RoomPage, {
    global: {
      stubs: {
        'scroll-view': { template: '<div><slot /></div>' },
        ConfirmModal: true,
        ChatMessage: true,
        Button: { template: '<button><slot /></button>' },
      },
    },
  })

  try {
    fixture.onLoad?.()
    await page.get('.story-empty button').trigger('click')
    await flushPromises()
    expect(page.findAll('.story-option').map((item) => item.text())).toEqual(['First story3 段'])
    await page.get('.picker-more').trigger('click')
    await flushPromises()
    expect(fixture.listPage.mock.calls).toEqual([[undefined], ['next']])
    expect(page.findAll('.story-option').map((item) => item.text())).toEqual(['First story3 段', 'Second story4 段'])
    await page.findAll('.story-option')[1].trigger('click')
    await page.findAll('.picker-foot button')[1].trigger('click')
    expect(page.get('.story-current .story-name').text()).toBe('Second story')
    await page.get('.start-game-btn').trigger('click')
    expect(fixture.roomStart).toHaveBeenCalledWith('room-1', 'second.txt')
  } finally {
    page.unmount()
    vi.unstubAllGlobals()
  }
})
