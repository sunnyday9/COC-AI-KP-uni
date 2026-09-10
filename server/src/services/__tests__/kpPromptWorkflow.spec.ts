/**
 * kpPromptService workflow 分支 spec（P26）— dossier 知识源说明必须把
 * verify_original 写成"事实问的默认动作"，同时保持 rag 分支逐字节不变。
 */
import { describe, it, expect } from 'vitest'
import { WORKFLOW_KNOWLEDGE_SOURCE, baseInstructionsFor } from '../kpPromptService.js'

describe('kpPromptService: workflow 知识源说明', () => {
  it('dossier：列出全部查证工具，且要求"档案没写清的具体事实先查证原文"', () => {
    const dossier = WORKFLOW_KNOWLEDGE_SOURCE.dossier
    for (const tool of ['scene_list', 'scene_dossier', 'lexical_search', 'verify_original']) {
      expect(dossier).toContain(tool)
    }
    // 事实问默认动作（P26 的核心）：不许凭印象作答
    expect(dossier).toMatch(/具体事实|人名|地点|时间|数字/)
    expect(dossier).toContain('未取得')
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
})
