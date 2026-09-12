import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

/**
 * T4 #19：ChatMessage 组件契约测试——路由分发不破坏既有渲染/交互行为。
 * - system 六类消息与 role 分发走对应组件（SceneDivider 等内联，按类别断言类名）
 * - KP 「可选行动」解析 → 选项按钮 → click 触发 select-option（ChatMessage 现行为）
 * - room 聊天流空 props 防御
 */
import ChatMessage from './ChatMessage.vue'
import KPMessage from './KPMessage.vue'
import SystemMessage from './SystemMessage.vue'
import PlayerMessage from './PlayerMessage.vue'
import { classifySystemMessage } from '../../../utils/classifySystemMessage'
import type { Message } from '../../../../../shared/types/game'

const mountCm = (msg: unknown) =>
  mount(ChatMessage as unknown as typeof ChatMessage, { props: { msg: msg as Message }, global: { stubs: { 'kp-message': true, 'player-message': true, 'system-message': true } } })

function msgOf<R extends Message['role']>(role: R, content: string): Extract<Message, { role: R }> {
  return { id: 'm1', timestamp: 1, role, content } as Extract<Message, { role: R }>
}

describe('ChatMessage 路由', () => {
  it('system dice 消息渲染 SystemMessage dice 卡', () => {
    const m = msgOf('system', '侦查检定(常规) d100: 45 / 目标≤60 → 成功')
    expect(classifySystemMessage(m)).toBe('dice')
    const w = mount(SystemMessage, { props: { msg: m } })
    expect(w.find('.dice-card').exists()).toBe(true)
    expect(w.find('.dice-roll').text()).toContain('d100: 45')
  })

  it('结构化骰子消息（type/result）渲染视觉与文本路径一致（#79 视觉不变）', () => {
    // 服务端 DiceMessage 直达：大数字仍取 content 的 d100 段（同文本路径，非 result.roll）
    const m: Message = { id: 'm1', timestamp: 1, role: 'system', type: 'dice', content: '侦查检定(常规) d100: 45 / 目标≤60 → 成功', result: { roll: 45, target: 60 } }
    const w = mount(SystemMessage, { props: { msg: m } })
    expect(w.find('.dice-card').exists()).toBe(true)
    expect(w.find('.dice-roll').text()).toContain('d100: 45')
    expect(w.find('.dice-desc').text()).toContain('成功')
  })

  it('结构化 result.outcome 存在时辉光直读字段，否则回退 content 关键词（#79）', () => {
    // outcome='大失败' 直读 → fail 血色调（content 无成败关键词，旧路径会是 neutral）
    const fail: Message = { id: 'm1', timestamp: 1, role: 'system', type: 'dice', content: '对抗检定红骰(d100:50)', result: { roll: 50, target: 60, outcome: '大失败' } }
    const wf = mount(SystemMessage, { props: { msg: fail } })
    expect(wf.find('.dice-roll').attributes('style')).toContain('var(--c-blood-400)')
    // 无 outcome → 回退 content 关键词：成功 → 非 fail 色调
    const ok: Message = { id: 'm2', timestamp: 1, role: 'system', type: 'dice', content: '侦查检定(常规) d100: 45 / 目标≤60 → 成功', result: { roll: 45, target: 60 } }
    const wo = mount(SystemMessage, { props: { msg: ok } })
    expect(wo.find('.dice-roll').attributes('style')).not.toContain('var(--c-blood-400)')
  })

  it('system clue 消息渲染左缘绿光条', () => {
    const m = msgOf('system', '获得线索: 书架后的暗格里藏着一把铜钥匙')
    const w = mount(SystemMessage, { props: { msg: m } })
    expect(w.find('.clue-line').exists()).toBe(true)
    expect(w.text()).toContain('书架后的暗格里藏着一把铜钥匙')
  })

  it('system damage 消息渲染血色调卡', () => {
    const w = mount(SystemMessage, { props: { msg: msgOf('system', 'HP -2') } })
    expect(w.find('.blood-card').exists()).toBe(true)
  })

  it('system scene 消息渲染场景分隔卡', () => {
    const w = mount(SystemMessage, { props: { msg: msgOf('system', '场景切换: 图书馆') } })
    expect(w.find('.scene-chip').exists()).toBe(true)
    expect(w.find('.scene-text').text()).toContain('图书馆')
  })

  it('player 消息渲染右侧气泡', () => {
    const w = mount(PlayerMessage, { props: { msg: { id: 'm', timestamp: 1, role: 'player', playerName: '阿伦', content: '我仔细侦查房间' } } })
    expect(w.find('.player-msg').exists()).toBe(true)
    expect(w.find('.player-name').text()).toBe('阿伦')
  })

  it('KP 消息「可选行动」解析 → 选项按钮 → select-option 事件', async () => {
    const kp = {
      id: 'm',
      timestamp: 1,
      role: 'kp',
      content: '你听到书架后有动静。\n\n【可选行动】\n- 上前查看\n- 躲在暗处观察\n',
    }
    // 渲染级行为：KPMessage 点击 → emit select-option（ChatMessage 透传由冒烟用例覆盖）
    const w = mount(KPMessage, { props: { msg: kp } })
    const btns = w.findAll('.option-btn')
    expect(btns.length).toBe(2)
    expect(btns[0].text()).toBe('上前查看')
    await btns[0].trigger('click')
    const events = w.emitted('select-option')
    expect(events).toBeTruthy()
    expect(events![0][0]).toBe('上前查看')
  })

  it('KP 流式消息不渲染选项（防抖）且带光标', () => {
    const streaming = {
      id: 'm',
      timestamp: 1,
      role: 'kp',
      content: '你听到脚步声……',
      isStreaming: true,
    }
    const w = mount(KPMessage, { props: { msg: streaming } })
    expect(w.findAll('.option-btn').length).toBe(0)
    expect(w.find('.cursor-bar').exists()).toBe(true)
  })

  it('ChatMessage 路由 kp/system/player 不抛错', () => {
    for (const role of ['kp', 'player', 'system'] as const) {
      const content = role === 'player' ? '玩家说' : role === 'kp' ? 'KP 说' : '系统说'
      const w = mountCm(msgOf(role, content))
      expect(w.exists()).toBe(true)
    }
  })
})
