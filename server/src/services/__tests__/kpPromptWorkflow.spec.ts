/**
 * kpPromptService workflow 分支 spec（P26）— dossier 知识源说明必须把
 * verify_original 写成"事实问的默认动作"，同时保持 rag 分支逐字节不变。
 */
import { describe, it, expect } from 'vitest'
import { WORKFLOW_KNOWLEDGE_SOURCE, baseInstructionsFor, BASE_INSTRUCTIONS, buildKnowledgeBlock } from '../kpPromptService.js'

describe('kpPromptService: workflow 知识源说明', () => {
  it('dossier：列出全部查证工具，且要求"档案没写清的具体事实先查证原文"', () => {
    const dossier = WORKFLOW_KNOWLEDGE_SOURCE.dossier
    for (const tool of ['scene_list', 'scene_dossier', 'lexical_search', 'verify_original']) {
      expect(dossier).toContain(tool)
    }
    // 事实问默认动作（P26 的核心）：逐项都在（不用析取正则——那会让规则退化到只剩一个词也通过）
    for (const kind of ['人名', '地点', '时间', '数字']) {
      expect(dossier).toContain(kind)
    }
    expect(dossier).toContain('必须先调用 verify_original')
    expect(dossier).toContain('禁止凭印象作答')
    expect(dossier).toContain('未取得')
    expect(dossier).toContain('原文收录')
    // 剧透层约束仍在
    expect(dossier).toContain('剧透层')
  })

  it('rag：不出现 dossier 查证工具（保持历史措辞）', () => {
    for (const tool of ['scene_list', 'scene_dossier', 'lexical_search', 'verify_original']) {
      expect(WORKFLOW_KNOWLEDGE_SOURCE.rag).not.toContain(tool)
    }
    expect(WORKFLOW_KNOWLEDGE_SOURCE.rag).toContain('故事情报')
  })

  it('baseInstructionsFor 替换占位符：两分支都不残留 {KNOWLEDGE_SOURCE_INSTRUCTION}', () => {
    for (const wf of ['rag', 'dossier'] as const) {
      const text = baseInstructionsFor(wf)
      expect(text).not.toContain('{KNOWLEDGE_SOURCE_INSTRUCTION}')
      expect(text).toContain('克苏鲁的呼唤第七版')
    }
    expect(baseInstructionsFor('dossier')).toContain('verify_original')
    expect(baseInstructionsFor('rag')).not.toContain('verify_original')
  })

  it('rag 分支逐字节等于"占位符替换为 rag 措辞"的 BASE_INSTRUCTIONS（P26 回归守门）', () => {
    const expected = BASE_INSTRUCTIONS.replace('{KNOWLEDGE_SOURCE_INSTRUCTION}', WORKFLOW_KNOWLEDGE_SOURCE.rag)
    expect(baseInstructionsFor('rag')).toBe(expected)
    // 占位符之外的内容在替换前后逐字节不变
    expect(baseInstructionsFor('rag').replace(WORKFLOW_KNOWLEDGE_SOURCE.rag, '{KNOWLEDGE_SOURCE_INSTRUCTION}')).toBe(BASE_INSTRUCTIONS)
    // 两分支只在知识源那一行不同
    const strip = (s: string) => s.split('\n').filter((l, i) => i !== 1).join('\n')
    expect(strip(baseInstructionsFor('rag'))).toBe(strip(baseInstructionsFor('dossier')))
  })
})

describe('kpPromptService: 预取查证块（P27）', () => {
  it('dossier：场景块之后追加「原文查证」小节；缺省/空串 → 逐字节保持原形态', () => {
    const scene = '场景：旧图书馆\n现场描述：灰尘与霉味。'
    const base = buildKnowledgeBlock('dossier', '', scene)
    expect(base).toBe(`\n## 当前场景档案\n${scene}`)
    expect(buildKnowledgeBlock('dossier', '', scene, '')).toBe(base)
    expect(buildKnowledgeBlock('dossier', '', scene, '   ')).toBe(base)

    const withVerify = buildKnowledgeBlock('dossier', '', scene, '【原文查证】海哥本名海华。')
    expect(withVerify).toContain('## 当前场景档案')
    expect(withVerify).toContain('## 原文查证（服务端已自动检索，供你对齐事实）')
    expect(withVerify.indexOf('## 原文查证')).toBeGreaterThan(withVerify.indexOf('## 当前场景档案'))
  })

  it('无场景块时（回退故事情报）仍带查证小节；rag 分支不带（预取只走 dossier）', () => {
    const dossierNoScene = buildKnowledgeBlock('dossier', '检索到的一些情报', '', '【原文查证】结论')
    expect(dossierNoScene).toContain('## 故事情报')
    expect(dossierNoScene).toContain('## 原文查证')
    // rag 房没有预取通路：即便误传 verifyBlock 也不进提示词
    const rag = buildKnowledgeBlock('rag', 'rag 情报', '', '【原文查证】结论')
    expect(rag).not.toContain('原文查证')
    expect(rag).toBe('\n## 故事情报\nrag 情报')
  })
})
