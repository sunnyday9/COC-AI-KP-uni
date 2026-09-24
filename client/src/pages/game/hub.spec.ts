import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pageLifecycle = vi.hoisted(() => ({
  onShow: undefined as (() => void) | undefined,
  roomListSolo: vi.fn(),
  roomList: vi.fn(),
}))

vi.mock('@dcloudio/uni-app', () => ({
  onShow: (callback: () => void) => { pageLifecycle.onShow = callback },
}))

vi.mock('../../platform', () => ({
  getBridge: () => ({
    roomListSolo: pageLifecycle.roomListSolo,
    roomList: pageLifecycle.roomList,
  }),
}))

import HubPage from './hub.vue'

describe('game hub page lifecycle', () => {
  beforeEach(() => {
    pageLifecycle.onShow = undefined
    pageLifecycle.roomListSolo.mockReset().mockResolvedValue([])
    pageLifecycle.roomList.mockReset().mockResolvedValue([{
      roomId: 'room-1',
      inviteCode: 'ABC123',
      storyId: null,
      phase: 'playing',
      updatedAt: 1,
    }])
  })

  it('loads on first show and refreshes again when returning from a room', async () => {
    const uniApi = { navigateTo: vi.fn(), redirectTo: vi.fn(), reLaunch: vi.fn() }
    vi.stubGlobal('uni', uniApi)

    const wrapper = mount(HubPage, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          AppIcon: true,
          Button: true,
          EmptyState: true,
        },
      },
    })

    expect(pageLifecycle.onShow).toBeTypeOf('function')
    expect(pageLifecycle.roomListSolo).not.toHaveBeenCalled()
    expect(pageLifecycle.roomList).not.toHaveBeenCalled()

    await pageLifecycle.onShow?.()
    await flushPromises()
    expect(pageLifecycle.roomListSolo).toHaveBeenCalledTimes(1)
    expect(pageLifecycle.roomList).toHaveBeenCalledTimes(1)

    await pageLifecycle.onShow?.()
    await flushPromises()
    expect(pageLifecycle.roomListSolo).toHaveBeenCalledTimes(2)
    expect(pageLifecycle.roomList).toHaveBeenCalledTimes(2)

    await wrapper.find('.investigation-card').trigger('click')
    expect(uniApi.navigateTo).toHaveBeenCalledWith({ url: '/pages/game/index?roomId=room-1' })

    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})
