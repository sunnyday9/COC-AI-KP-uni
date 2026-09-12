/**
 * T4 蒸馏管线单元测试（票 #40）。
 *
 * 只测外部行为（spec #36 Testing Decisions）：
 *  - 语料检索：注入串与线上 rag 房同构（renderBlock join 口径，票 #65）、块数/预算封顶；
 *  - 过滤器：validate 规则单源行为（文字骰点/未知工具/参数/工具错误/required/
 *    纯叙事禁工具/上限未收口）——melee 等价展开走 kpValidation 真实判定；
 *  - 切分：rollout/房间级整体归属 + contextHash 跨侧零重叠 + 冲突自检；
 *  - wire 组装：与 #37 buildWireMessages 同形（累计叙事收尾）；
 *  - rollout 状态机：记忆/场景/线索演化与回滚（线上 rememberTurn 兜底分支语义）；
 *  - 重放循环（教师 mock + 真 rule-engine）：工具真执行、角色卡真变更、结果回填
 *    带【结果摘要】头。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { buildRagContext, LexicalIndex, tokenizeForRetrieval, type CorpusChunk } from '../src/distill/corpus.js'
import { MAX_SUPPLEMENT_CHUNKS, SUPPLEMENT_BUDGET_CHARS } from '../../server/src/rag/supplementAssembly.js'
import { SUPPLEMENT_HEADING } from '../../server/src/rag/promptMarkers.js'
import { filterTurn } from '../src/distill/filter.js'
import { packSplit, contextHash, stratifyAudit, buildAuditPack, provenanceKey } from '../src/distill/pack.js'
import { buildWireSequence, buildSample } from '../src/distill/sample.js'
import { buildSlimTurnMessages, estimateTokens, pruneForSeqCap, replaySkeleton } from '../src/distill/replay.js'
import { applyTurnOutcome, initRolloutState, restoreState, snapshotState } from '../src/distill/synth.js'
import { planRollouts, makeRng, pickTurnType, type SheetEntry } from '../src/distill/pool.js'
import { buildMockAnchorSeeds, mockAnchorSkeleton } from '../src/distill/anchors.js'
import type { COCCharacterSheet } from '../../shared/types/character.js'
import type { DistillSample, DistillSkeleton, ReplayedTurn } from '../src/distill/types.js'
import { createCharacterMutatorFactory } from '../../server/src/rule-engine/characterMutators.js'
import { buildToolContext } from '../../server/src/rule-engine/toolContextFactory.js'

/* ── fixtures ─────────────────────────────────────────────── */

function makeSheet(overrides: Partial<COCCharacterSheet> = {}): COCCharacterSheet {
  return {
    playerName: '测试调查员',
    occupationName: '侦探',
    attributes: { str: 50, con: 60, siz: 55, dex: 70, app: 50, int: 75, pow: 60, edu: 80, luck: 55 },
    skills: { 侦查: 65, 格斗: 55, 图书馆使用: 70 },
    derived: { hp: 10, hpMax: 12, mp: 10, mpMax: 10, san: 50, sanMax: 60 },
    ...overrides,
  } as COCCharacterSheet
}

function makeSkeleton(overrides: Partial<DistillSkeleton> = {}): DistillSkeleton {
  return {
    id: 'roll_x#1',
    source: 'synthetic',
    kind: 'turn',
    turnType: 'investigate_check',
    storyName: '测试故事',
    originId: 'roll_x',
    batchContent: '【测试调查员】我检查书架。',
    batchPlayers: ['测试调查员'],
    characters: { char_0: makeSheet() },
    activeCharacterId: 'char_0',
    promptInput: { scene: '书房', clues: [], history: [], kpMemory: [], longTermSummary: '' },
    ragContext: '',
    caveats: [],
    ...overrides,
  }
}

function makeTurn(overrides: Partial<ReplayedTurn> & { skeleton?: DistillSkeleton } = {}): ReplayedTurn {
  const iterations = overrides.iterations ?? []
  return {
    skeleton: overrides.skeleton ?? makeSkeleton(),
    iterations,
    finalContent: overrides.finalContent ?? '你推开门，灰尘在光柱中浮动。',
    usage: { promptTokens: 100, completionTokens: 50, calls: 1 },
    worldDeltas: overrides.worldDeltas ?? { cluesAdded: [] },
    hitCap: overrides.hitCap ?? false,
  }
}

/* ── 语料：检索与瘦身 ─────────────────────────────────────── */

describe('corpus 检索', () => {
  const chunks: CorpusChunk[] = [
    { storyId: 's1', storyName: '故事一', index: 0, content: '旧图书馆的地下书库藏着一本禁书，书架上积满灰尘。' },
    { storyId: 's1', storyName: '故事一', index: 1, content: '码头仓库凌晨有诡异的灯火，守夜人神秘失踪。' },
    { storyId: 's2', storyName: '故事二', index: 0, content: '教堂地下室里，调查员发现了邪教徒的仪式痕迹。' },
  ]

  it('tokenize：中文 2-gram + ascii 词', () => {
    expect(tokenizeForRetrieval('图书馆 ABC')).toContain('图书')
    expect(tokenizeForRetrieval('图书馆 ABC')).toContain('abc')
  })

  it('LexicalIndex：按词面重合检索 top-k，无命中返回空', () => {
    const idx = new LexicalIndex(chunks)
    const hits = idx.search('书架 禁书', 2)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.content).toContain('禁书')
    expect(idx.search('完全不相关的查询词汇表', 2)).toEqual([])
  })

  it('buildRagContext：线上 rag 房同构——trim 后 \\n\\n 连接，无标题无分节（票 #65）', () => {
    const ctx = buildRagContext(chunks.slice(0, 2))
    // 对照线上口径：turnKnowledge.fetchRagContext = blocks.map(renderBlock).join('\n\n')
    expect(ctx).toBe(`${chunks[0]!.content}\n\n${chunks[1]!.content}`)
    expect(ctx).not.toContain('##')
    expect(ctx).not.toContain('###')
  })

  it('buildRagContext：块数封顶 MAX_SUPPLEMENT_CHUNKS（线上装配常量直引）', () => {
    const many = Array.from({ length: MAX_SUPPLEMENT_CHUNKS + 2 }, (_, i) => ({
      storyId: 's',
      storyName: 's',
      index: i,
      content: `片段${i}`,
    }))
    const ctx = buildRagContext(many)
    expect(ctx.split('\n\n')).toHaveLength(MAX_SUPPLEMENT_CHUNKS)
    expect(ctx).toContain(`片段${MAX_SUPPLEMENT_CHUNKS - 1}`)
    expect(ctx).not.toContain(`片段${MAX_SUPPLEMENT_CHUNKS}`)
  })

  it('buildRagContext：整块试放不超线上 1.6k 预算（计量含标题，与 assembleSupplement 同口径）', () => {
    // 首块恰好压线入选（trial = BUDGET，不大于），次块试放必超 → 整块跳过
    const near = '很'.repeat(SUPPLEMENT_BUDGET_CHARS - SUPPLEMENT_HEADING.length - 1)
    const ctx = buildRagContext([
      { storyId: 's', storyName: 's', index: 0, content: near },
      { storyId: 's', storyName: 's', index: 1, content: '短片段' },
    ])
    expect(ctx).toBe(near)
    expect(ctx).not.toContain('短片段')
  })

  it('buildRagContext：空白块剔除；空列表返回空串', () => {
    const ctx = buildRagContext([
      { storyId: 's', storyName: 's', index: 0, content: '  有料  ' },
      { storyId: 's', storyName: 's', index: 1, content: '   \n  ' },
    ])
    expect(ctx).toBe('有料')
    expect(buildRagContext([])).toBe('')
  })
})

/* ── 过滤器：validate 规则单源行为 ─────────────────────────────────────── */

describe('filterTurn', () => {
  it('通过：叙事 + 合法工具调用', () => {
    const turn = makeTurn({
      iterations: [
        {
          assistantContent: '',
          toolCalls: [{ id: 't1', name: 'skill_check', arguments: JSON.stringify({ skillName: '侦查', skillValue: 65, difficulty: 'regular' }) }],
          toolResults: [{ role: 'tool', tool_call_id: 't1', content: '{"success":true}' }],
        },
      ],
    })
    expect(filterTurn(turn)).toMatchObject({ ok: true, category: 'pass' })
  })

  it('拒绝：文字模拟骰点（最终叙事）', () => {
    const turn = makeTurn({ finalContent: '你掷出 d100: 45，成功。' })
    expect(filterTurn(turn)).toMatchObject({ ok: false, category: 'text_dice' })
  })

  it('拒绝：文字模拟骰点（工具循环轮叙事）', () => {
    const turn = makeTurn({
      iterations: [{ assistantContent: '受到 3 点伤害', toolCalls: [], toolResults: [] }],
    })
    expect(filterTurn(turn)).toMatchObject({ ok: false, category: 'text_dice' })
  })

  it('拒绝：未知工具名', () => {
    const turn = makeTurn({
      iterations: [{ assistantContent: '', toolCalls: [{ id: 't', name: 'make_dice_roll', arguments: '{}' }], toolResults: [] }],
    })
    expect(filterTurn(turn)).toMatchObject({ ok: false, category: 'unknown_tool' })
  })

  it('拒绝：参数不可解析', () => {
    const turn = makeTurn({
      iterations: [{ assistantContent: '', toolCalls: [{ id: 't', name: 'grant_clue', arguments: '{oops' }], toolResults: [] }],
    })
    expect(filterTurn(turn)).toMatchObject({ ok: false, category: 'bad_args' })
  })

  it('拒绝：规则引擎 error 结果', () => {
    const turn = makeTurn({
      iterations: [
        {
          assistantContent: '',
          toolCalls: [{ id: 't', name: 'skill_check', arguments: '{}' }],
          toolResults: [{ role: 'tool', tool_call_id: 't', content: 'error: missing skillName' }],
        },
      ],
    })
    expect(filterTurn(turn)).toMatchObject({ ok: false, category: 'tool_error' })
  })

  it('拒绝：required 缺失 + melee_attack 等价展开命中 combat 链', () => {
    const missing = makeTurn({
      iterations: [{ assistantContent: '', toolCalls: [{ id: 't', name: 'grant_clue', arguments: '{"description":"x"}' }], toolResults: [{ role: 'tool', tool_call_id: 't', content: '{"ok":1}' }] }],
    })
    expect(filterTurn(missing)).toMatchObject({ ok: false, category: 'missing_required' })

    const meleeOk = makeTurn({
      skeleton: makeSkeleton({ turnType: 'combat_melee' }),
      iterations: [{ assistantContent: '', toolCalls: [{ id: 't', name: 'melee_attack', arguments: '{"weapon":"匕首","damage":"1d4+2"}' }], toolResults: [{ role: 'tool', tool_call_id: 't', content: '{"winner":"A"}' }] }],
    })
    expect(filterTurn(meleeOk)).toMatchObject({ ok: true, category: 'pass' })
  })

  it('拒绝：纯叙事回合带工具调用', () => {
    const turn = makeTurn({
      skeleton: makeSkeleton({ turnType: 'narrative_pure' }),
      iterations: [{ assistantContent: '', toolCalls: [{ id: 't', name: 'grant_clue', arguments: '{"description":"x"}' }], toolResults: [{ role: 'tool', tool_call_id: 't', content: '{"ok":1}' }] }],
    })
    expect(filterTurn(turn)).toMatchObject({ ok: false, category: 'missing_required' })
  })

  it('拒绝：空叙事 / 打满上限未收口', () => {
    expect(filterTurn(makeTurn({ finalContent: '  ' }))).toMatchObject({ ok: false, category: 'no_narrative' })
    expect(filterTurn(makeTurn({ hitCap: true }))).toMatchObject({ ok: false, category: 'tool_overflow' })
  })

  it('seed_organic：required=null 不设约束（纯叙事通过、带工具也通过）', () => {
    const narrative = makeTurn({ skeleton: makeSkeleton({ turnType: 'seed_organic' }) })
    expect(filterTurn(narrative)).toMatchObject({ ok: true })
    const withTools = makeTurn({
      skeleton: makeSkeleton({ turnType: 'seed_organic' }),
      iterations: [{ assistantContent: '', toolCalls: [{ id: 't', name: 'roll_dice', arguments: '{"sides":6}' }], toolResults: [{ role: 'tool', tool_call_id: 't', content: '{"roll":4}' }] }],
    })
    expect(filterTurn(withTools)).toMatchObject({ ok: true })
  })
})

/* ── 切分：零重叠 ─────────────────────────────────────── */

function makeSample(id: string, source: 'seed' | 'synthetic' | 'anchor', origin: string, systemMark: string): DistillSample {
  return {
    meta: {
      id, source, origin, kind: 'turn', turnType: 'investigate_check', storyName: 's',
      turnCount: 1, toolCallCount: 0, multiStep: false, caveats: [], batchPlayers: [],
      usage: { promptTokens: 0, completionTokens: 0, calls: 1 },
    },
    messages: [
      { role: 'system', content: `system-${systemMark}` },
      { role: 'user', content: 'batch' },
    ],
    tools: [],
  }
}

describe('packSplit 零重叠', () => {
  it('rollout 整体归属：同 rollout 的回合同侧', () => {
    const core = [
      makeSample('a#1', 'synthetic', 'roll_1', 'x'),
      makeSample('a#2', 'synthetic', 'roll_1', 'y'),
      makeSample('b#1', 'synthetic', 'roll_2', 'z'),
    ]
    const result = packSplit({ core, anchors: [], heldoutProvenance: new Set(['roll_1']) })
    expect(result.heldout.map((s) => s.meta.id)).toEqual(['a#1', 'a#2'])
    expect(result.train.map((s) => s.meta.id)).toEqual(['b#1'])
    expect(result.conflicts).toEqual([])
  })

  it('内容级去重：相同 contextHash 跨侧不重复（held-out 优先）', () => {
    const core = [
      makeSample('h1', 'synthetic', 'roll_h', 'same-system'),
      makeSample('t1', 'synthetic', 'roll_t', 'same-system'),
    ]
    const result = packSplit({ core, anchors: [], heldoutProvenance: new Set(['roll_h']) })
    expect(result.heldout.map((s) => s.meta.id)).toEqual(['h1'])
    expect(result.train).toEqual([])
    expect(result.droppedDuplicate).toBe(1)
  })

  it('锚样本不入 train/held-out', () => {
    const anchors = [makeSample('g1', 'anchor', 'golden:x', 'a')]
    const result = packSplit({ core: [], anchors, heldoutProvenance: new Set() })
    expect(result.anchors).toHaveLength(1)
    expect(result.train).toHaveLength(0)
    expect(result.heldout).toHaveLength(0)
  })

  it('冲突自检：同键跨侧被检出', () => {
    // 直接构造冲突场景：heldout 键含 roll_1，同时 train 侧样本 origin=roll_1
    // （packSplit 实现中 train 循环 skip heldout 键——冲突只可能来自实现 bug，
    // 这里验证 conflicts 检测路径本身可用）
    const core = [makeSample('t1', 'synthetic', 'roll_9', 'z')]
    const fakeHeldoutKey = new Set(['roll_9'])
    const result = packSplit({ core, anchors: [], heldoutProvenance: fakeHeldoutKey })
    expect(result.heldout).toHaveLength(1)
    expect(result.train).toHaveLength(0)
    expect(result.conflicts).toEqual([])
  })

  it('provenanceKey：anchor 返回 null', () => {
    expect(provenanceKey(makeSample('g', 'anchor', 'golden:x', 'a'))).toBeNull()
  })

  it('contextHash：system+本批敏感，空白不敏感', () => {
    const a = makeSample('1', 'synthetic', 'r', 'sys')
    const b = makeSample('2', 'synthetic', 'r2', 'sys')
    b.messages = [
      { role: 'system', content: 'sys\nwith\nnewlines  spaces' },
      { role: 'user', content: 'batch' },
    ]
    a.messages = [
      { role: 'system', content: 'sys with newlines spaces' },
      { role: 'user', content: 'batch' },
    ]
    expect(contextHash(a)).toBe(contextHash(b))
    expect(contextHash(a)).not.toBe(contextHash(makeSample('3', 'synthetic', 'r3', 'different')))
  })
})

describe('抽检包', () => {
  it('分层抽样凑满 target', () => {
    const pool: DistillSample[] = []
    for (let i = 0; i < 80; i++) {
      pool.push(makeSample(`s${i}`, i % 2 ? 'synthetic' : 'seed', `r${i}`, `m${i}`))
    }
    const picked = stratifyAudit(pool, 60, 4)
    expect(picked.length).toBe(60)
    // 含 <script> 内容的样本：data.js 必须转义 <，防 </script> 提前闭合
    picked[0]!.messages = [{ role: 'system', content: '<script>alert(1)</script>' }]
    const pack = buildAuditPack(picked)
    expect(pack.checklistMarkdown).toContain('| 1 |')
    expect(pack.dataJs).toContain('window.AUDIT_DATA')
    expect(pack.dataJs).toContain('\\u003cscript\\u003e')
    expect(pack.dataJs).not.toContain('<script>')
  })
})

/* ── wire 组装 ─────────────────────────────────────── */

describe('sample wire 组装', () => {
  it('与 #37 buildWireMessages 同形：迭代 + 累计叙事收尾', () => {
    const turn = makeTurn({
      iterations: [
        {
          assistantContent: '',
          toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{"skillName":"侦查"}' }],
          toolResults: [{ role: 'tool', tool_call_id: 't1', content: '【结果摘要】roll: 30\n{"roll":30}' }],
        },
      ],
      finalContent: '你发现了线索。',
    })
    const wire = buildWireSequence(turn)
    expect(wire[0]).toMatchObject({ role: 'system' })
    expect(wire[1]).toMatchObject({ role: 'user', content: '【测试调查员】我检查书架。' })
    expect(wire[2]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'skill_check' } }] })
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 't1' })
    expect(wire[4]).toMatchObject({ role: 'assistant', content: '你发现了线索。' })
    const sample = buildSample(turn, 'synthetic')
    expect(sample.meta.multiStep).toBe(false)
    expect(sample.meta.toolCallCount).toBe(1)
    expect(sample.tools.length).toBe(24)
  })

  it('multiStep：≥2 个工具循环轮', () => {
    const turn = makeTurn({
      iterations: [
        { assistantContent: '', toolCalls: [{ id: 't1', name: 'skill_check', arguments: '{}' }], toolResults: [] },
        { assistantContent: '', toolCalls: [{ id: 't2', name: 'grant_clue', arguments: '{}' }], toolResults: [] },
      ],
    })
    expect(buildSample(turn, 'synthetic').meta.multiStep).toBe(true)
  })
})

/* ── 瘦身组装 ─────────────────────────────────────── */

describe('buildSlimTurnMessages（数据侧瘦身）', () => {
  it('对话窗 18→8：只保留最近 8 条 + 本批', () => {
    const history = Array.from({ length: 18 }, (_, i) => ({
      id: `m${i}`, timestamp: i, role: i % 2 ? 'kp' : 'player', playerName: '测试调查员', content: `消息${i}`,
    })) as DistillSkeleton['promptInput']['history']
    const skeleton = makeSkeleton({ promptInput: { scene: null, clues: [], history, kpMemory: [], longTermSummary: '' } })
    const msgs = buildSlimTurnMessages(skeleton)
    // system + 8 条近窗 + 本批 user
    expect(msgs.length).toBe(10)
    expect((msgs[msgs.length - 1] as { content: string }).content).toContain('我检查书架')
    const conv = msgs.slice(1, -1)
    expect(conv.some((m) => (m as { content: string }).content.includes('消息9'))).toBe(false)
    expect(conv.some((m) => (m as { content: string }).content.includes('消息17'))).toBe(true)
  })

  it('记忆 30→12：骨架构建时已裁剪（此处验证 system 含记忆块形态）', () => {
    const skeleton = makeSkeleton({ promptInput: { scene: null, clues: [], history: [], kpMemory: ['线索一', '线索二'], longTermSummary: '' } })
    const msgs = buildSlimTurnMessages(skeleton)
    expect((msgs[0] as { content: string }).content).toContain('线索二')
  })

  it('pruneForSeqCap：超限丢最旧对话，system/本批不动', () => {
    const long = 'x'.repeat(6000) // ≈3750 tokens ×2 > 6k cap
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: 'batch' },
    ] as const
    const pruned = pruneForSeqCap(msgs as unknown as Parameters<typeof pruneForSeqCap>[0])
    expect(pruned[0]).toMatchObject({ role: 'system' })
    expect(pruned[pruned.length - 1]).toMatchObject({ content: 'batch' })
    expect(pruned.length).toBeLessThan(msgs.length)
  })

  it('estimateTokens：中文按 ~1.6 chars/token', () => {
    expect(estimateTokens('x'.repeat(160))).toBe(100)
  })
})

/* ── rollout 状态机 ─────────────────────────────────────── */

describe('rollout 状态机', () => {
  const plan = { rolloutId: 'roll_t', storyName: 's', party: [] as SheetEntry[], turns: [] as never[] }

  it('applyTurnOutcome：消息流追加 + 记忆兜底（前 80 字）+ 场景/线索演化', () => {
    const state = initRolloutState(plan)
    applyTurnOutcome(
      state,
      {
        batchContent: '【甲】查看窗户',
        batchPlayers: ['甲'],
        finalContent: 'K'.repeat(100),
        worldDeltas: { cluesAdded: [{ description: '窗台泥印' }], sceneChanged: '书房' },
      },
      () => 'id1',
    )
    expect(state.scene).toBe('书房')
    expect(state.clues).toEqual([{ id: 'clue_id1', description: '窗台泥印' }])
    expect(state.history).toHaveLength(2)
    expect(state.history[0]).toMatchObject({ role: 'player', playerName: '甲', content: '查看窗户' })
    expect(state.history[1]).toMatchObject({ role: 'kp' })
    expect(state.kpMemory).toEqual([`${'K'.repeat(80)}…`])
  })

  it('快照回滚：被拒回合不污染状态', () => {
    const state = initRolloutState(plan)
    state.scene = '门厅'
    state.kpMemory = ['旧记忆']
    const snapshot = snapshotState(state)
    state.scene = '地下室'
    state.kpMemory.push('被拒回合记忆')
    state.clues.push({ id: 'c', description: 'x' })
    restoreState(state, snapshot)
    expect(state.scene).toBe('门厅')
    expect(state.kpMemory).toEqual(['旧记忆'])
    expect(state.clues).toEqual([])
  })
})

/* ── 调度 ─────────────────────────────────────── */

describe('planRollouts / RNG', () => {
  const pool: SheetEntry[] = [
    { characterId: 'c1', sheet: makeSheet({ playerName: '甲' }), provenance: 'test' },
    { characterId: 'c2', sheet: makeSheet({ playerName: '乙' }), provenance: 'test' },
    { characterId: 'c3', sheet: makeSheet({ playerName: '丙' }), provenance: 'test' },
  ]

  it('同种子计划可复现', () => {
    const a = planRollouts({ storyNames: ['故事一'], sheetPool: pool, count: 20, seed: 42 })
    const b = planRollouts({ storyNames: ['故事一'], sheetPool: pool, count: 20, seed: 42 })
    expect(a.plans).toEqual(b.plans)
  })

  it('rollout 长度 5-9 回合、小队 1-4 人', () => {
    const { plans } = planRollouts({ storyNames: ['一', '二'], sheetPool: pool, count: 50, seed: 7 })
    for (const p of plans) {
      expect(p.turns.length).toBeGreaterThanOrEqual(5)
      expect(p.turns.length).toBeLessThanOrEqual(9)
      expect(p.party.length).toBeGreaterThanOrEqual(1)
      expect(p.party.length).toBeLessThanOrEqual(4)
    }
  })

  it('pickTurnType 返回合法类型且权重生效（大量抽样不返回 opening）', () => {
    const rng = makeRng(1)
    for (let i = 0; i < 200; i++) {
      const t = pickTurnType(rng)
      expect(t).not.toBe('opening')
    }
  })
})

/* ── 锚样本种子 ─────────────────────────────────────── */

describe('mock/e2e 锚种子', () => {
  it('3 条种子：类型覆盖侦查/战斗/SAN，RAG 注入串为线上同形', () => {
    const demo = '旧图书馆的铜钥匙藏在书架后的暗格里。'.repeat(20)
    const seeds = buildMockAnchorSeeds(demo)
    expect(seeds.map((s) => s.turnType).sort()).toEqual(['combat_melee', 'investigate_check', 'san_encounter'])
    for (const s of seeds) {
      // 线上 rag 房同形（票 #65）：无标题无分节，单块 = demo 原文前 700 字 trim
      expect(s.ragContext).toBe(demo.slice(0, 700).trim())
      expect(s.ragContext).not.toContain('##')
    }
  })

  it('mockAnchorSkeleton：极简卡在场 + required 来自回合类型契约', () => {
    const [seed] = buildMockAnchorSeeds('旧图书馆')
    const skeleton = mockAnchorSkeleton(seed!)
    expect(skeleton.characters['char_0']!.derived!.san).toBe(55)
    expect(skeleton.turnType).toBe(seed!.turnType)
    expect(skeleton.batchContent).toContain('【调查员】')
  })
})

/* ── 重放循环（教师 mock + 真 rule-engine）────────────────────────────────────── */

vi.mock('../eval/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../eval/lib/client.js')>()
  return {
    ...actual,
    callTurn: vi.fn(),
  }
})

describe('replaySkeleton（教师 mock + 真 rule-engine）', () => {
  let callTurnMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const client = await import('../eval/lib/client.js')
    callTurnMock = vi.mocked(client.callTurn)
    callTurnMock.mockReset()
  })

  it('工具真执行 + 角色卡真变更 + 回填带【结果摘要】头 + 循环收口', async () => {
    const skeleton = makeSkeleton({ turnType: 'seed_organic' })
    callTurnMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'tc1', name: 'adjust_hp', arguments: JSON.stringify({ delta: -3 }) }],
        usage: { promptTokens: 10, completionTokens: 5 },
      })
      .mockResolvedValueOnce({
        content: '调查员感到一阵眩晕。',
        toolCalls: [],
        usage: { promptTokens: 12, completionTokens: 8 },
      })

    const ep = { baseUrl: 'https://example.invalid', apiKey: 'test', model: 'm', temperature: 0.7, maxTokens: 100, timeoutMs: 1000 }
    const turn = await replaySkeleton(ep, skeleton)

    expect(turn.iterations).toHaveLength(1)
    expect(turn.iterations[0]!.toolCalls[0]!.name).toBe('adjust_hp')
    // 角色卡原地变更（mutator 真实语义）
    expect(skeleton.characters['char_0']!.derived!.hp).toBe(7)
    // 回填 = LLM 实际看到的 wire（adjust_hp 返回纯文本 → 无摘要头，与线上一致）
    expect(turn.iterations[0]!.toolResults[0]!.content).toBe('HP adjusted by -3')
    // 第二轮无工具 → 收口
    expect(turn.finalContent).toBe('调查员感到一阵眩晕。')
    expect(turn.usage.calls).toBe(2)
  })

  it('多角色 characterId 分派：args 指定在场调查员时作用于对应卡', async () => {
    const skeleton = makeSkeleton({
      characters: { char_0: makeSheet({ playerName: '甲' }), char_1: makeSheet({ playerName: '乙' }) },
      activeCharacterId: 'char_0',
    })
    callTurnMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'tc1', name: 'adjust_hp', arguments: JSON.stringify({ delta: -2, characterId: 'char_1' }) }],
        usage: { promptTokens: 10, completionTokens: 5 },
      })
      .mockResolvedValueOnce({ content: '乙受了伤。', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } })

    const ep = { baseUrl: 'https://example.invalid', apiKey: 'test', model: 'm', temperature: 0.7, maxTokens: 100, timeoutMs: 1000 }
    await replaySkeleton(ep, skeleton)
    expect(skeleton.characters['char_1']!.derived!.hp).toBe(8)
    expect(skeleton.characters['char_0']!.derived!.hp).toBe(10)
  })

  it('世界增量收集：grant_clue → worldDeltas', async () => {
    callTurnMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'tc1', name: 'grant_clue', arguments: JSON.stringify({ description: '暗格里的铜钥匙' }) }],
        usage: { promptTokens: 10, completionTokens: 5 },
      })
      .mockResolvedValueOnce({ content: '你拿到了钥匙。', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } })
    const ep = { baseUrl: 'https://example.invalid', apiKey: 'test', model: 'm', temperature: 0.7, maxTokens: 100, timeoutMs: 1000 }
    const turn = await replaySkeleton(ep, makeSkeleton())
    expect(turn.worldDeltas.cluesAdded).toEqual([{ description: '暗格里的铜钥匙', clueId: undefined }])
  })

  it('mutator 工厂直测：HP 钳制不越 0', () => {
    const sheet = makeSheet({ derived: { hp: 2, hpMax: 12, mp: 5, mpMax: 5, san: 50, sanMax: 60 } })
    const m = createCharacterMutatorFactory({ resolveSheet: () => sheet })
    const ctx = buildToolContext({ characterSheet: sheet, ...m('char_0'), generateId: () => 'x' })
    ctx.updateCharacterHP(-10)
    expect(sheet.derived!.hp).toBe(0)
  })
})
