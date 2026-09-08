/**
 * dossier schema v2 spec — graph layer (transitions/events/npc relations/meta),
 * name→id reference normalization (resolveRefs), structural quality gate
 * (assessDossier), and cross-batch merge semantics (mergeDossierParts).
 */
import { describe, it, expect } from 'vitest'
import {
  parseDossierJson,
  resolveRefs,
  assessDossier,
  type StoryDossier,
} from '../schema.js'
import { mergeDossierParts } from '../prompts.js'

describe('dossier schema v2', () => {
  it('parses the v2 graph shape (transitions/events/relations/meta)', () => {
    const raw = {
      scriptId: 's.pdf',
      scenes: [{ id: 'scene_1', name: '码头', sceneText: '海风腥咸。', npcIds: ['npc_1'] }],
      npcs: [
        { id: 'npc_1', name: '后藤静香', relations: [{ target: '永井纯', type: '仇人', note: '兽医绝育计划' }] },
      ],
      transitions: [{ id: 'tr_1', from: '码头', to: '后藤宅', condition: '白天有人引路', viaClues: ['传单'] }],
      events: [
        { id: 'ev_1', when: '2 月 16 日夜', summary: '诊所麻醉药失窃', scene: '田代诊所', critical: true },
      ],
      meta: { title: '猫是我', timeframe: '2024 年 4 月', premise: '上岛寻人', background: '岛上猫多' },
    }
    const d = parseDossierJson(JSON.stringify(raw))
    expect(d).not.toBeNull()
    expect(d!.transitions).toHaveLength(1)
    expect(d!.transitions![0].viaClues).toEqual(['传单'])
    expect(d!.events).toHaveLength(1)
    expect(d!.events![0].critical).toBe(true)
    expect(d!.npcs[0].relations![0].target).toBe('永井纯')
    expect(d!.meta).toMatchObject({ timeframe: '2024 年 4 月', background: '岛上猫多' })
  })

  it('keeps a graph-only batch (no scenes/clues/npcs) as a valid part', () => {
    const d = parseDossierJson(JSON.stringify({ events: [{ summary: '某日某事' }], transitions: [{ from: 'A', to: 'B' }] }))
    expect(d).not.toBeNull()
    expect(d!.events).toHaveLength(1)
    expect(d!.scenes).toHaveLength(0)
  })

  it('parse drops malformed graph entries but keeps valid siblings', () => {
    const raw = {
      scenes: [{ id: 's1', name: 'A', sceneText: 't' }],
      transitions: [{ from: 'A' }, { from: 'A', to: 'B' }, 'junk'],
      events: [{ when: '夜' }, { summary: '事件' }],
      npcs: [{ name: 'X', relations: [{ type: '亲属' }, { target: 'Y', type: '敌对' }] }],
    }
    const d = parseDossierJson(JSON.stringify(raw))
    expect(d).not.toBeNull()
    expect(d!.transitions).toEqual([expect.objectContaining({ from: 'A', to: 'B' })])
    expect(d!.events).toEqual([expect.objectContaining({ summary: '事件' })])
    expect(d!.npcs[0].relations).toEqual([expect.objectContaining({ target: 'Y', type: '敌对' })])
  })

  it('resolveRefs rewrites name refs to ids and leaves orphans untouched', () => {
    const d = parseDossierJson(JSON.stringify({
      scenes: [
        { id: 's1', name: '码头', sceneText: '' },
        { id: 's2', name: '后藤宅', sceneText: '', clueIds: ['后门钥匙'] },
      ],
      clues: [{ id: 'c1', description: '后门钥匙' }],
      npcs: [{ id: 'n1', name: '后藤静香' }, { id: 'n2', name: '永井纯' }],
      transitions: [
        { from: '码头', to: '后藤宅', viaClues: ['后门钥匙'] },
        { from: '不存在之地', to: '码头' },
      ],
      events: [{ summary: 'e', scene: '码头', npcs: ['永井纯'] }],
    }))
    const r = resolveRefs(d!)
    expect(r.transitions![0]).toMatchObject({ from: 's1', to: 's2', viaClues: ['c1'] })
    // orphan edge stays as-is (runtime name lookup still possible)
    expect(r.transitions![1].from).toBe('不存在之地')
    expect(r.scenes[1].clueIds).toEqual(['c1'])
  })

  it('assessDossier flags orphans, low sceneText coverage and sparse scenes', () => {
    const base: StoryDossier = {
      scriptId: 's',
      storyName: 's',
      generatedAt: 0,
      scenes: [{ id: 's1', name: 'A', sceneText: 'x'.repeat(300) }],
      clues: [],
      npcs: [{ id: 'n1', name: 'N' }],
      transitions: [{ from: 'A', to: '幽灵场景' }],
      events: [{ summary: 'e', scene: 'A' }, { summary: 'e2', scene: '未知场景' }],
    }
    const q = assessDossier(base, 10_000)
    expect(q.orphanTransitions).toEqual(['A→幽灵场景'])
    expect(q.orphanEventScenes).toHaveLength(1)
    expect(q.orphanRelations).toEqual([])
    expect(q.warnings.some((w) => w.includes('覆盖'))).toBe(true)
    expect(q.warnings.some((w) => w.includes('欠抽'))).toBe(true)
    expect(q.coveragePct).toBeLessThan(15)
  })

  it('assessDossier accepts a clean dense dossier without warnings', () => {
    const q = assessDossier({
      scriptId: 's',
      storyName: 's',
      generatedAt: 0,
      scenes: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `场景${i}`, sceneText: '字'.repeat(900) })),
      clues: [],
      npcs: [{ id: 'n1', name: 'N' }],
      transitions: [{ from: 's0', to: 's1' }],
      events: [{ summary: 'e', scene: 's0' }],
    }, 12_000)
    expect(q.warnings).toEqual([])
    expect(q.coveragePct).toBe(90)
  })

  it('mergeDossierParts merges cross-batch npc relations and keeps edge order', () => {
    const a = parseDossierJson(JSON.stringify({
      scenes: [{ id: 's1', name: '码头', sceneText: 't1' }],
      npcs: [{ id: 'n1', name: '后藤静香', relations: [{ target: '永井纯', type: '仇人' }] }],
      transitions: [{ from: '码头', to: 'A', condition: 'c1' }],
      events: [{ when: '夜', summary: '失窃' }],
    }))!
    const b = parseDossierJson(JSON.stringify({
      scenes: [{ id: 's2', name: '诊所', sceneText: 't2' }],
      npcs: [{ id: 'n1b', name: '后藤静香', details: '原 PETA 成员', relations: [{ target: '山寺', type: '秘密关联' }, { target: '永井纯', type: '仇人' }] }],
      transitions: [{ from: '诊所', to: '码头' }, { from: '码头', to: 'A', condition: 'c1' }],
      events: [{ when: '昼', summary: '问诊' }],
    }))!
    const m = mergeDossierParts([a, b])
    expect(m.scenes).toHaveLength(2)
    const npc = m.npcs.find((n) => n.name === '后藤静香')!
    expect(npc.details).toBe('原 PETA 成员')
    expect(npc.relations).toHaveLength(2) // 跨批去重：重复的 仇人/永井纯 不双记
    expect(m.transitions).toHaveLength(2) // 边去重按 from|to：b 批重复的 码头→A 不双记
    expect(m.events).toHaveLength(2)
  })
})
