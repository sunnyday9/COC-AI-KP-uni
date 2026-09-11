/**
 * 提示词与开关接线 spec（M1-T6 / issue #50，TDD）。
 *
 * 契约（spec #44 / ADR-0007 决策 1/5/6）：
 *  - 档案房 system：场景档案块之后追加检索补充小节；
 *  - **知识源口径**：检索补充层只作描写素材、事实以档案为准（与 ADR-0007 决策 1 一致）；
 *  - 总开关 `rag.supplement`（默认开）：关闭 → 小节完全消失、检索不发生；
 *  - 注入形态：独立小节、位置在档案块之后；
 *  - rag 房不走图路径（T6 起改标准管线产出情报块）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildKnowledgeBlock,
  WORKFLOW_KNOWLEDGE_SOURCE,
  SUPPLEMENT_SOURCE_NOTE,
} from '../kpPromptService.js'

const SCENE_BLOCK = '场景：门厅\n简介：进门处。'
const SUPPLEMENT = '## 原文片段（检索补充·仅作描写素材）\n铜灯下的地毯泛着暗红。'

describe('kpPromptService: 补充小节位置与形态', () => {
  it('档案房：补充小节追加在场景档案块之后', () => {
    const out = buildKnowledgeBlock('dossier', '', SCENE_BLOCK, '', SUPPLEMENT)
    const sceneAt = out.indexOf('## 当前场景档案')
    const supAt = out.indexOf('## 原文片段（检索补充·仅作描写素材）')
    expect(sceneAt).toBeGreaterThanOrEqual(0)
    expect(supAt).toBeGreaterThan(sceneAt)
    expect(out).toContain('铜灯下的地毯泛着暗红。')
  })

  it('补充小节为空 → 输出与未接线时逐字节相同（关闭开关 = 现状）', () => {
    const before = buildKnowledgeBlock('dossier', '', SCENE_BLOCK)
    const off = buildKnowledgeBlock('dossier', '', SCENE_BLOCK, '', '')
    expect(off).toBe(before)
  })

  it('补充小节的正文原样保留（不加工、不改写）', () => {
    const out = buildKnowledgeBlock('dossier', '', SCENE_BLOCK, '', SUPPLEMENT)
    expect(out).toContain(SUPPLEMENT)
  })

  it('档案房但无匹配场景（开局）→ 回退情报块，补充小节仍追加', () => {
    const out = buildKnowledgeBlock('dossier', '检索到的旧情报。', '', '', SUPPLEMENT)
    expect(out).toContain('## 故事情报')
    expect(out).toContain('## 原文片段（检索补充·仅作描写素材）')
  })

  it('审查：verifyBlock 与 supplement 同时存在时顺序稳定（查证 → 补充）', () => {
    const out = buildKnowledgeBlock('dossier', '', SCENE_BLOCK, '【原文查证】结论。', SUPPLEMENT)
    const verifyAt = out.indexOf('## 原文查证')
    const supAt = out.indexOf('## 原文片段（检索补充·仅作描写素材）')
    expect(verifyAt).toBeGreaterThan(0)
    expect(supAt).toBeGreaterThan(verifyAt)
  })
})

describe('kpPromptService: 知识源口径（双轨分工）', () => {
  it('档案房知识源说明含"描写素材 + 事实以档案为准"口径', () => {
    const src = WORKFLOW_KNOWLEDGE_SOURCE.dossier
    expect(src).toContain('检索补充')
    expect(src).toContain('描写素材')
    expect(src).toContain('以档案为准')
  })

  it('rag 房知识源说明**不含**该口径（逐字节差异断言，先例：workflow 提示词测试）', () => {
    const src = WORKFLOW_KNOWLEDGE_SOURCE.rag
    expect(src).not.toContain('描写素材')
    expect(src).not.toContain('以档案为准')
    expect(src).not.toContain('检索补充')
  })

  it('SUPPLEMENT_SOURCE_NOTE 常量本身即口径文案（单源，供 prompt 与文档引用）', () => {
    expect(SUPPLEMENT_SOURCE_NOTE).toContain('描写素材')
    expect(SUPPLEMENT_SOURCE_NOTE).toContain('以档案为准')
    expect(WORKFLOW_KNOWLEDGE_SOURCE.dossier).toContain(SUPPLEMENT_SOURCE_NOTE)
  })
})

describe('settings: rag.supplement 开关', () => {
  const uid = 900_001

  it('默认开（未设置过的用户读到的就是 true）', async () => {
    const { DEFAULT_SETTINGS } = await import('../settingsService.js')
    expect(DEFAULT_SETTINGS.rag?.supplement).toBe(true)
    const { getSettings } = await import('../settingsService.js')
    expect(getSettings(uid).rag?.supplement).toBe(true)
  })

  it('可显式关闭并持久化（saveSettings → getSettings 读回 false）', async () => {
    const { saveSettings, getSettings } = await import('../settingsService.js')
    saveSettings(uid, { rag: { supplement: false } })
    expect(getSettings(uid).rag?.supplement).toBe(false)
    // 再显式打开
    saveSettings(uid, { rag: { supplement: true } })
    expect(getSettings(uid).rag?.supplement).toBe(true)
  })

  it('patch 里不给 supplement → 保持默认开（不被 undefined 覆盖）', async () => {
    const { saveSettings, getSettings } = await import('../settingsService.js')
    saveSettings(uid, { rag: { useEmbeddings: true } })
    expect(getSettings(uid).rag?.supplement).toBe(true)
  })

  it('validatePatch 不因未知 rag 字段抛错（开关是合法字段）', async () => {
    const { validatePatch } = await import('../settingsService.js')
    expect(() => validatePatch({ rag: { supplement: false } })).not.toThrow()
  })
})
