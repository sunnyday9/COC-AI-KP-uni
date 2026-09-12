/**
 * 注入小节标记单源 spec（issue #63）。
 *
 * 契约：
 *  - 4 个标记常量**逐字节钉死**——它们是 server 注入端与评测脚本（ab-compare.mjs
 *    等）嗅探端之间的显式接口，改值 = 改 wire 接口，#42 gate 报告统计会静默归零；
 *  - 注入端（buildKnowledgeBlock / renderVerifyContent / renderUnavailable）确实
 *    引用常量产出标记（防"常量旁路"回归）；
 *  - ab-compare 嗅探从「前缀字面量」升为「全标题常量」判定等价：wire 采样把
 *    system（initialMessages）与 tool 回填**逐字**落库（wireSampleService），小节
 *    标题在 wire 里只以完整形态出现在小节开头，无中途截断路径，故
 *    `includes(全标题)` ≡ 旧 `includes(前缀)`，`indexOf` 定位相同 → 摘录相同。
 */
import { describe, it, expect } from 'vitest'
import {
  SUPPLEMENT_HEADING,
  VERIFY_CONTENT_MARKER,
  VERIFY_SECTION_HEADING,
  VERIFY_SPOILER_MARKER,
} from '../promptMarkers.js'
import { buildKnowledgeBlock } from '../../services/kpPromptService.js'
import { renderUnavailable, renderVerifyContent } from '../dossier/originalLookup.js'

describe('promptMarkers（#63 注入小节标记显式接口）', () => {
  it('常量值逐字节钉死（值稳定：改值须连评测脚本与基线口径一起评审）', () => {
    expect(VERIFY_SECTION_HEADING).toBe('## 原文查证（服务端已自动检索，供你对齐事实）')
    expect(VERIFY_CONTENT_MARKER).toBe('【原文查证')
    expect(VERIFY_SPOILER_MARKER).toBe('【剧透层·仅限 KP 内部裁定，禁止向玩家复述】')
    expect(SUPPLEMENT_HEADING).toBe('## 原文片段（检索补充·仅作描写素材）')
  })

  it('注入端确实引用常量产出标记（防常量旁路）', () => {
    // verify 小节进 system（dossier 房，带场景块与预取结论）
    const block = buildKnowledgeBlock('dossier', '', '当前场景档案文本', '预取结论', '')
    expect(block).toContain(`\n${VERIFY_SECTION_HEADING}\n预取结论\n`)
    // rag 房不注入 verify 小节（调用方 gate 的第二道闸）
    expect(buildKnowledgeBlock('rag', '检索上下文', '', '预取结论', '')).not.toContain(VERIFY_SECTION_HEADING)
    // 工具回填：kp_only 剧透标注 + 场景名变体
    expect(renderVerifyContent({ answer: '结论文本', spoiler: 'kp_only', sceneName: '书房' })).toBe(
      VERIFY_SPOILER_MARKER + VERIFY_CONTENT_MARKER + '·书房】结论文本',
    )
    expect(renderVerifyContent({ answer: '结论文本', spoiler: 'normal' })).toBe(
      VERIFY_CONTENT_MARKER + '】结论文本',
    )
    // 未取得降级文本同以标记开头
    expect(renderUnavailable('原文缺失').startsWith(`${VERIFY_CONTENT_MARKER}】未取得：原文缺失。`)).toBe(true)
  })
})

/**
 * ab-compare.mjs 嗅探逻辑的等价性对拍（#63 验收 3）：同一段样例 wire 消息，
 * 「旧字面量前缀判定」与「新常量判定」的命中与摘录必须逐字节一致。
 * 旧嗅探字面量（重构前 ab-compare.mjs:411/417/427 的原值）在此作为钉值保留。
 */
const OLD_VERIFY_CONTENT_SNIFF = '【原文查证'
const OLD_VERIFY_SECTION_SNIFF = '## 原文查证（服务端已自动检索'
const OLD_SUPPLEMENT_SNIFF = '## 原文片段（检索补充'

/** ab-compare 嗅探形态：filter(role + includes) → indexOf 定位 → slice 摘录。 */
function sniff(msgs: { role: string; content: string }[], role: string, needle: string, cap: number): string[] {
  return msgs
    .filter((m) => m.role === role && m.content.includes(needle))
    .map((m) => {
      const i = m.content.indexOf(needle)
      return m.content.slice(i, i + cap)
    })
}

describe('ab-compare 嗅探等价（#63）：旧前缀字面量 vs 新常量', () => {
  // 样例 wire：system（含预取小节 + 补充小节）+ tool（命中/剧透/未取得三种回填）+ 负例
  const systemMsg = {
    role: 'system',
    content:
      buildKnowledgeBlock(
        'dossier',
        '',
        '书房的墙上挂着一幅褪色的画像。',
        renderVerifyContent({ answer: '画像下藏着钥匙。', quote: '钥匙躺在画框之后', spoiler: 'normal', sceneName: '书房' }),
        `\n${SUPPLEMENT_HEADING}\n【片段1】书房的窗帘是深绿色的。（场景内·书房）\n`,
      ) + '\n## 记忆：你（守密人）在本局已说过的内容\n',
  }
  const toolMsgs = [
    { role: 'tool', content: renderVerifyContent({ answer: '门是锁着的。', spoiler: 'normal', sceneName: '门厅' }) },
    { role: 'tool', content: renderVerifyContent({ answer: '仪式在午夜开始。', spoiler: 'kp_only', sceneName: '阁楼' }) },
    { role: 'tool', content: renderUnavailable('原文中未找到该信息') },
  ]
  const negativeMsgs = [
    { role: 'system', content: '你是克苏鲁的呼唤第七版（COC 7th）的守密人（Keeper/KP）。' },
    { role: 'tool', content: 'scene_list 调用成功：共 3 个场景。' },
    { role: 'assistant', content: '你推开门，一股霉味扑面而来。' },
  ]
  const wire = [systemMsg, ...toolMsgs, ...negativeMsgs]

  it('tool 消息：VERIFY_CONTENT_MARKER 与旧前缀字面量判定恒等（值本身就相同）', () => {
    expect(sniff(wire, 'tool', VERIFY_CONTENT_MARKER, 700)).toEqual(sniff(wire, 'tool', OLD_VERIFY_CONTENT_SNIFF, 700))
    expect(sniff(wire, 'tool', VERIFY_CONTENT_MARKER, 700)).toHaveLength(3)
  })

  it('system 消息：全标题常量与旧前缀字面量判定恒等（wire 逐字落库，标题必以完整形态出现）', () => {
    expect(sniff(wire, 'system', VERIFY_SECTION_HEADING, 600)).toEqual(sniff(wire, 'system', OLD_VERIFY_SECTION_SNIFF, 600))
    expect(sniff(wire, 'system', SUPPLEMENT_HEADING, 2000)).toEqual(sniff(wire, 'system', OLD_SUPPLEMENT_SNIFF, 2000))
    expect(sniff(wire, 'system', VERIFY_SECTION_HEADING, 600)).toHaveLength(1)
    expect(sniff(wire, 'system', SUPPLEMENT_HEADING, 2000)).toHaveLength(1)
    // 摘录从标题起点开始（与旧判定同位）——#42 报告口径不变
    expect(sniff(wire, 'system', VERIFY_SECTION_HEADING, 600)[0].startsWith(VERIFY_SECTION_HEADING)).toBe(true)
  })

  it('负例批次：两种判定都为空（不误报）', () => {
    expect(sniff(negativeMsgs, 'system', VERIFY_SECTION_HEADING, 600)).toEqual(
      sniff(negativeMsgs, 'system', OLD_VERIFY_SECTION_SNIFF, 600),
    )
    expect(sniff(negativeMsgs, 'system', VERIFY_SECTION_HEADING, 600)).toHaveLength(0)
    expect(sniff(negativeMsgs, 'tool', VERIFY_CONTENT_MARKER, 700)).toHaveLength(0)
    expect(sniff(negativeMsgs, 'system', SUPPLEMENT_HEADING, 2000)).toHaveLength(0)
  })
})
