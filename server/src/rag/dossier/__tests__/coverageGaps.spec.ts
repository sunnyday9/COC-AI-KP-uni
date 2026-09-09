/**
 * coverageGaps spec（P22，TDD）— 覆盖缺口纯函数（块切分/逐字覆盖判定/span 合并/
 * 场景锚点）+ 落盘往返。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gaps-spec-'))
vi.stubEnv('UPLOADS_DIR', path.join(tmpRoot, 'uploads'))
vi.stubEnv('DOSSIER_DATA_DIR', path.join(tmpRoot, 'dossiers'))
vi.resetModules()

const {
  normalizeText,
  splitStoryBlocks,
  computeCoverageGaps,
  persistGaps,
  loadGaps,
  deleteGaps,
} = await import('../coverageGaps.js')

describe('coverageGaps: 分块', () => {
  it('按空行分段并保留偏移', () => {
    const text = '第一段AAAAAAAAAAAAAAA\n第二行延续\n\n第三段BBBBBBBBBBBBBBBBBB'
    const blocks = splitStoryBlocks(text)
    expect(blocks.length).toBe(2)
    expect(blocks[0]?.start).toBe(0)
    expect(blocks[1]?.text).toContain('第三段')
  })
  it('长段（>900 字）在句末切分，块偏移连续且完整覆盖段落', () => {
    const para = `${'甲'.repeat(120)}。${'乙'.repeat(800)}。${'丙'.repeat(300)}`
    const text = `开头短段。\n\n${para}\n\n收尾短段。`
    const blocks = splitStoryBlocks(text)
    const paraBlocks = blocks.filter((b) => b.text.includes('甲') || b.text.includes('乙') || b.text.includes('丙'))
    expect(paraBlocks.length).toBeGreaterThanOrEqual(3) // 按句末切成甲段/乙段/丙段
    for (const b of blocks) expect(b.end - b.start).toBeLessThanOrEqual(950)
    const span = paraBlocks.reduce(
      (acc, b) => ({ start: Math.min(acc.start, b.start), end: Math.max(acc.end, b.end) }),
      { start: Number.MAX_SAFE_INTEGER, end: 0 },
    )
    expect(span.end - span.start).toBe(para.length)
  })
})

describe('coverageGaps: 覆盖判定 + span 合并', () => {
  const para = (label: string, n: number) => `${label}${'景'.repeat(n)}`
  const story = [
    para('第一段场景描述', 60),
    '\n\n',
    para('第二段场景描述', 60),
    '\n\n',
    para('第三段背景介绍', 60),
    '\n\n',
    para('第四段结局说明', 60),
  ].join('')

  it('逐字誊抄的段被覆盖；未誊抄段成为 gap span（含偏移与预览）', () => {
    const scenes = [
      { id: 's1', name: '场景一', sceneText: `第一段场景描述${'景'.repeat(60)}` },
      { id: 's2', name: '场景二', sceneText: `第二段场景描述${'景'.repeat(60)}` },
      { id: 's4', name: '场景四', sceneText: `第四段结局说明${'景'.repeat(60)}` },
    ]
    const gaps = computeCoverageGaps(story, scenes as never)
    expect(gaps.gapCount).toBe(1)
    expect(gaps.spans[0]?.preview).toContain('第三段背景介绍')
    expect(story.slice(gaps.spans[0]?.start ?? 0, gaps.spans[0]?.end ?? 0)).toContain('第三段背景介绍')
    expect(gaps.gapChars).toBeGreaterThan(0)
    expect(gaps.gapPct).toBeGreaterThan(0)
    expect(gaps.sceneTextChars).toBeGreaterThan(0)
  })

  it('sceneText 开头被改写、后段逐字誊抄 → 仍判覆盖（多窗口取样）', () => {
    // 段落 ≥128 字才有 0/40/80 三个取样窗；前 50 字被改写 → 80 号窗仍在逐字区
    const filler = '景'.repeat(120)
    const para = `第一段场景描述${filler}` // 128 字
    const sceneText = `【改写的开场白】${'润'.repeat(50)}${para.slice(50)}`
    const story2 = `${para}\n\n${'第二段场景描述' + '景'.repeat(60)}`
    const gaps = computeCoverageGaps(story2, [{ id: 's1', name: '场景一', sceneText }] as never)
    // 第一段覆盖（80 窗命中）；第二段未覆盖 → gap
    expect(gaps.gapCount).toBe(1)
    expect(gaps.spans[0]?.preview).toContain('第二段')
  })

  it('场景 sceneText 在原文完全无逐字对应（纯摘要）→ 全部 gap + 锚点 matched=false', () => {
    const scenes = [{ id: 'sx', name: '纯摘要场景', sceneText: '这个场景完全是模型改写的摘要文字，原文里找不到。' }]
    const gaps = computeCoverageGaps(story, scenes as never)
    expect(gaps.sceneAnchors[0]).toMatchObject({ id: 'sx', matched: false })
    expect(gaps.sceneAnchors[0]?.starts).toBeUndefined()
    expect(gaps.spans.length).toBeGreaterThan(0)
  })

  it('场景锚点：逐字场景给出原文位置（sceneText 带改写前缀时仍命中中段）', () => {
    const needle = para('第二段场景描述', 60)
    // LLM 风格：前缀衔接语 + 中段逐字誊抄（衔接语 >120 字时头部样本漏，中段样本命中）
    const sceneText = `${'衔接语'.repeat(80)}${needle}`
    const scenes = [{ id: 's2', name: '场景二', sceneText }]
    const gaps = computeCoverageGaps(story, scenes as never)
    const anchor = gaps.sceneAnchors[0]
    expect(anchor?.matched).toBe(true)
    const at = anchor?.starts?.[0] ?? -1
    // 命中位置应是 sceneText 逐字部分在原文的起点（衔接语不算）
    expect(at).toBeGreaterThanOrEqual(0)
    const prefixLen = sceneText.indexOf(needle)
    expect(anchor?.starts?.some((s) => story.slice(s, s + 8).includes('第二段'))).toBe(true)
    void prefixLen
  })

  it('归一化对换行/空白不敏感（PDF 排版差异）', () => {
    expect(normalizeText('甲 乙\n丙\t丁')).toBe('甲乙丙丁')
    const st = `第一段很长的话甲乙丙丁戊己庚辛壬癸子丑。\n换行后继续第二行内容依然逐字誊抄进档案场景文本里。`
    const scenes = [{ id: 's', name: 'x', sceneText: '第一段很长的话甲乙丙丁戊己庚辛壬癸子丑。换行后继续第二行内容依然逐字誊抄进档案场景文本里。' }]
    const gaps = computeCoverageGaps(st, scenes as never)
    expect(gaps.gapCount).toBe(0)
  })

  it('空原文 / 空 scenes 不崩', () => {
    expect(computeCoverageGaps('', [] as never).gapCount).toBe(0)
    const g = computeCoverageGaps(story, [] as never)
    expect(g.gapCount).toBeGreaterThan(0)
    expect(g.gapPct).toBe(100)
  })
})

describe('coverageGaps: 落盘往返 + 删除', () => {
  it('persist/load/delete .gaps.json', async () => {
    const file = {
      scriptId: 'demo.txt',
      storyName: 'demo',
      generatedAt: 1,
      storyChars: 100,
      sceneTextChars: 10,
      gapCount: 1,
      gapChars: 90,
      gapPct: 90,
      spans: [{ start: 10, end: 100, chars: 90, preview: '未被覆盖的段落预览' }],
      sceneAnchors: [{ id: 's1', name: '场景一', matched: false }],
    }
    await persistGaps(1, file)
    const loaded = await loadGaps(1, 'demo.txt')
    expect(loaded?.gapPct).toBe(90)
    expect(loaded?.spans[0]?.preview).toContain('未被覆盖')
    await deleteGaps(1, 'demo.txt')
    expect(await loadGaps(1, 'demo.txt')).toBeNull()
  })
})

/* ═════════ 集成：generateDossier 自动算 gaps 并落盘 ═════════ */

const A_PARA = `教学楼一层的走廊尽头有一扇铁门，常年上锁，钥匙在管理员手里。据说十年前地下室曾经发生过火灾，之后就再没人下去了。`
const B_PARA = `图书馆的角落摆着一张旧书桌，桌面刻满划痕，抽屉里散落着发黄的借阅记录。管理员对此闭口不谈。`
const C_PARA = `档案室在顶楼西侧，需要教务处的通行证才能进入，里面存放着历年的学生档案与事故记录。`

const dossierFixture = {
  scriptId: '',
  storyName: '测试剧本',
  scenes: [
    { id: 'sc_a', name: '教学楼', sceneText: A_PARA, description: '' },
    { id: 'sc_b', name: '图书馆', sceneText: B_PARA, description: '' },
  ],
  clues: [],
  npcs: [],
  transitions: [],
}

vi.mock('../../../services/aiService.js', () => ({
  chatForRag: vi.fn(async () => ({ content: JSON.stringify(dossierFixture) })),
}))
vi.mock('../../../services/storyService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/storyService.js')>()
  return { ...actual, readStoryForRag: vi.fn(async () => ({ name: 'gaps.txt', content: `${A_PARA}\n\n${B_PARA}\n\n${C_PARA}` })) }
})

describe('coverageGaps: generateDossier 集成', () => {
  let userId = 1
  beforeEach(async () => {
    userId = 1
    await fs.mkdir(path.join(tmpRoot, 'uploads', String(userId), 'stories'), { recursive: true })
  })

  it('生成后落盘 .gaps.json：逐字段覆盖、未收录段成 gap；deleteDossier 清理', async () => {
    const { generateDossier, loadDossier, deleteDossier } = await import('../storyDossierService.js')
    const { importStory } = await import('../../../services/storyService.js')
    const up = await importStory(userId, { originalname: 'gaps-demo.txt', buffer: Buffer.from('占位'), size: 6 })
    const scriptId = up.id as string
    const res = await generateDossier(userId, scriptId)
    expect(res.ok).toBe(true)
    // 两段被覆盖 → 只有 C 段一个 gap
    expect(res.gapCount).toBe(1)
    expect(res.gapPct).toBeGreaterThan(0)
    expect(res.gapChars).toBeGreaterThan(0)
    const dossier = await loadDossier(userId, scriptId)
    expect(dossier?.coverageGaps).toMatchObject({ count: 1 })
    const gaps = await loadGaps(userId, scriptId)
    expect(gaps?.spans[0]?.preview).toContain('档案室在顶楼西侧')
    expect(gaps?.sceneAnchors).toHaveLength(2)
    expect(gaps?.sceneAnchors.every((a) => a.matched)).toBe(true)
    await deleteDossier(userId, scriptId)
    expect(await loadGaps(userId, scriptId)).toBeNull()
  })
})
