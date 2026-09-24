// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppLayout from './AppLayout.vue'

describe('AppLayout custom navigation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('replaces custom-tab pages and keeps Home as a relaunch destination', async () => {
    const uniApi = { navigateTo: vi.fn(), redirectTo: vi.fn(), reLaunch: vi.fn() }
    vi.stubGlobal('uni', uniApi)

    const wrapper = mount(AppLayout, {
      props: { active: 'scripts' },
      global: { stubs: { ToastContainer: true, AppIcon: true } },
    })
    const tabs = wrapper.findAll('.nav-item')

    await tabs[2].trigger('click')
    expect(uniApi.redirectTo).toHaveBeenCalledWith({ url: '/pages/game/hub' })
    expect(uniApi.navigateTo).not.toHaveBeenCalled()

    await tabs[0].trigger('click')
    expect(uniApi.reLaunch).toHaveBeenCalledWith({ url: '/pages/home/index' })
  })
})
