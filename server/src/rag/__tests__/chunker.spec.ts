/**
 * 服务端递归语义切块器 spec（M1-T1 / issue #45，TDD）。
 *
 * 契约（见 spec #44 与 ADR-0007）：
 *  - 纯函数：同输入同输出，无 IO/网络/模型；
 *  - 递归层级 标题 → 段落 → 句末标点，逐级下沉直到低于目标长度；
 *  - 每块带 `start` 字符偏移，可还原回原文子串（`text.slice(start, start+content.length)`）；
 *  - 目标块长与重叠由参数控制（缺省 ~800 / ~100）；
 *  - 超短片段不单独成块；空白归一化不改变偏移语义。
 */
import { describe, it, expect } from 'vitest'
import { chunkStoryText, DEFAULT_CHUNK_CHARS, DEFAULT_CHUNK_OVERLAP } from '../chunker.js'

/** 偏移契约：每块都能在原文里对回自己的内容。 */
function assertOffsets(text: string, chunks: { content: string; start: number }[]): void {
  for (const c of chunks) {
    expect(text.slice(c.start, c.start + c.content.length)).toBe(c.content)
  }
}

describe('chunker: 基本契约', () => {
  it('空输入 → 空数组；纯空白同理', () => {
    expect(chunkStoryText('')).toEqual([])
    expect(chunkStoryText('   \n\n  \t ')).toEqual([])
  })

  it('短文本（低于目标长度）→ 单块，偏移 0', () => {
    const text = '图书馆的密信藏在第三排书架后面。'
    const chunks = chunkStoryText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toBe(text)
    expect(chunks[0]?.start).toBe(0)
    assertOffsets(text, chunks)
  })

  it('单字符输入不崩', () => {
    expect(() => chunkStoryText('甲')).not.toThrow()
  })

  it('偏移契约：纯文本 / 标题文档 / 长段落，所有块都能还原', () => {
    const para = (label: string, n: number) => `${label}${'内容'.repeat(Math.ceil(n / 2)).slice(0, n)}`
    const cases = [
      [para('段一', 300), para('段二', 300), para('段三', 300)].join('\n\n'),
      ['# 第一章 引子', para('正文', 500), '## 场景：旧图书馆', para('场景正文', 900)].join('\n\n'),
      para('超长单段开头', 2_600),
    ]
    for (const text of cases) {
      const chunks = chunkStoryText(text)
      expect(chunks.length).toBeGreaterThan(0)
      assertOffsets(text, chunks)
    }
  })

  it('确定性：同输入两次调用结果一致', () => {
    const text = ['# 标题', '第一段'.repeat(200), '第二段'.repeat(200)].join('\n\n')
    expect(chunkStoryText(text)).toEqual(chunkStoryText(text))
  })
})

describe('chunker: 递归层级', () => {
  it('标题优先：Markdown 标题处切分（标题与正文同块，不孤立）', () => {
    const sec1 = `# 第一章\n\n${'甲'.repeat(400)}`
    const sec2 = `# 第二章\n\n${'乙'.repeat(400)}`
    const text = `${sec1}\n\n${sec2}`
    const chunks = chunkStoryText(text, { chunkChars: 500 })
    // 两章分别成块（各自 <500 不合并跨越标题）
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.content).toContain('第一章')
    expect(chunks[0]?.content).toContain('甲')
    expect(chunks[1]?.content).toContain('第二章')
    assertOffsets(text, chunks)
  })

  it('段落层级：超长章节按空行切段', () => {
    const text = `## 场景\n\n${'甲'.repeat(600)}\n\n${'乙'.repeat(600)}\n\n${'丙'.repeat(600)}`
    const chunks = chunkStoryText(text, { chunkChars: 700 })
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    assertOffsets(text, chunks)
  })

  it('句末层级：超长单段按句末标点切（。！？）', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `这是第${i + 1}句，${'词'.repeat(60)}。`)
    const text = sentences.join('')
    expect(text.length).toBeGreaterThan(800)
    const chunks = chunkStoryText(text)
    expect(chunks.length).toBeGreaterThan(1)
    // 除最后一块外，其余块应以句末标点收尾（不在句子中间切断）
    for (const c of chunks.slice(0, -1)) {
      expect(/[。！？]["'」』）)]?$/.test(c.content)).toBe(true)
    }
    assertOffsets(text, chunks)
  })

  it('目标长度与重叠生效：块长不超目标（除非单句本身超长）', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i}段：${'字'.repeat(180)}。`).join('\n\n')
    const chunks = chunkStoryText(text, { chunkChars: 600, overlap: 80 })
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(600 * 1.5)
    assertOffsets(text, chunks)
  })

  it('缺省参数可覆写，且导出缺省常量', () => {
    expect(DEFAULT_CHUNK_CHARS).toBe(800)
    expect(DEFAULT_CHUNK_OVERLAP).toBe(100)
    const text = '甲'.repeat(2_000)
    const fewer = chunkStoryText(text, { chunkChars: 1_000 })
    const more = chunkStoryText(text, { chunkChars: 400 })
    expect(more.length).toBeGreaterThan(fewer.length)
  })
})

describe('chunker: 边界与健壮性', () => {
  it('末块过短 → 内容不丢（并入前块，按原文区间取）', () => {
    // 回归：曾把过短尾块拼进前一块时丢字符（799甲 + "短" → 输出不含"短"）
    const cases = [
      `${'甲'.repeat(799)}\n\n短`,
      `${'甲'.repeat(799)}\n\n${'中'.repeat(10)}`,
      `${'甲'.repeat(780)}\n\n${'乙'.repeat(10)}\n\n${'丙'.repeat(780)}`,
    ]
    for (const text of cases) {
      const chunks = chunkStoryText(text)
      const all = chunks.map((c) => c.content).join('')
      // 每个非空白字符都必须出现在某块里
      const nonWs = text.replace(/\s/g, '')
      for (const ch of new Set(nonWs)) expect(all).toContain(ch)
      assertOffsets(text, chunks)
    }
  })

  it('首块过短 → 并入后块（不丢内容、偏移仍指向原文）', () => {
    const text = `短\n\n${'丙'.repeat(900)}`
    const chunks = chunkStoryText(text, { minChunkChars: 40 })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.map((c) => c.content).join('')).toContain('短')
    assertOffsets(text, chunks)
  })

  it('全文往返：块序列覆盖原文全部非空白字符（顺序一致）', () => {
    const text = ['# 第一章', '甲'.repeat(500), '## 场景：图书馆', '乙'.repeat(700), '尾段短句。'].join('\n\n')
    const chunks = chunkStoryText(text)
    const joined = chunks.map((c) => c.content).join('')
    const compact = (s: string) => s.replace(/\s/g, '')
    // 顺序覆盖：去掉空白后，原文每个字符按序出现（允许块间重叠导致的重复 → 用子序列判定）
    const needle = compact(text)
    const hay = compact(joined)
    let i = 0
    for (const ch of hay) if (i < needle.length && ch === needle[i]) i++
    expect(i).toBe(needle.length)
  })

  it('重叠语义钉住：相邻块在原文上有 ≈overlap 字符交叠（不是 0）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i + 1}段：${'字'.repeat(200)}。`).join('\n\n')
    const chunks = chunkStoryText(text, { chunkChars: 500, overlap: 60 })
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as { content: string; start: number }
      const cur = chunks[i] as { content: string; start: number }
      const overlapChars = prev.start + prev.content.length - cur.start
      expect(overlapChars).toBeGreaterThan(0)
      expect(overlapChars).toBeLessThanOrEqual(60)
    }
  })

  it('超短片段（<minChunkChars）不单独成块', () => {
    const text = `${'甲'.repeat(700)}\n\n短\n\n${'乙'.repeat(700)}`
    const chunks = chunkStoryText(text, { chunkChars: 800, minChunkChars: 40 })
    for (const c of chunks) expect(c.content.trim().length).toBeGreaterThanOrEqual(40)
    assertOffsets(text, chunks)
  })

  it('大量空白（PDF 排版痕迹）不产生空块', () => {
    const text = `${'甲'.repeat(400)}\n\n\n\n\n\n${'乙'.repeat(400)}\n\n   \n\n`
    const chunks = chunkStoryText(text)
    for (const c of chunks) expect(c.content.trim().length).toBeGreaterThan(0)
    assertOffsets(text, chunks)
  })

  it('CRLF 换行同样按段落切分（偏移仍可还原）', () => {
    const text = `${'甲'.repeat(600)}\r\n\r\n${'乙'.repeat(600)}`
    const chunks = chunkStoryText(text, { chunkChars: 700 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    assertOffsets(text, chunks)
  })

  it('无句末标点的超长串仍能切开（硬切兜底）', () => {
    const text = '甲'.repeat(2_500)
    const chunks = chunkStoryText(text, { chunkChars: 800 })
    expect(chunks.length).toBeGreaterThan(1)
    assertOffsets(text, chunks)
  })
})
