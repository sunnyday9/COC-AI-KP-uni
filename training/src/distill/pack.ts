/**
 * 打包与切分（T4）：train / held-out 零重叠 + 锚样本并入 + 分层抽检包 + 数据卡统计。
 *
 * 零重叠的实现层级（票 #40 验收 2）：
 *  1. 出处级：synthetic 按 rollout 整体归属（同一场合成对局的所有回合同侧——回合
 *     间共享演化状态，拆侧即泄漏）；seed 按房间/存档 id 整体归属；
 *  2. 内容级：contextHash（system+本批 的 sha256）跨侧去重；
 *  3. 锚样本独立成文件（anchors.jsonl，不进 held-out）：金样本锚的 context 与
 *     #42 gate 评测集同源——数据卡如实披露该重叠与使用建议。
 */
import { createHash } from 'node:crypto'
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.js'
import type { DistillSample } from './types.js'

/** context 侧指纹：system 消息 + 本批 user 消息（去掉空白差异）。 */
export function contextHash(sample: DistillSample): string {
  const msgs = sample.messages as { role: string; content: string }[]
  const system = msgs.find((m) => m.role === 'system')?.content ?? ''
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? ''
  return createHash('sha256').update(`${system}\u0000${lastUser}`.replace(/\s+/g, ' ')).digest('hex')
}

/** 出处分组键：synthetic=rollout id；seed=room/save id；anchor=独立文件不参与。 */
export function provenanceKey(sample: DistillSample): string | null {
  if (sample.meta.source === 'anchor' || sample.meta.source === 'human') return null
  return sample.meta.origin
}

export interface PackOptions {
  core: DistillSample[]
  anchors: DistillSample[]
  /** held-out 出处键集合（rollout/房间级，plan 阶段按 seed 指派）。 */
  heldoutProvenance: Set<string>
}

export interface PackResult {
  train: DistillSample[]
  heldout: DistillSample[]
  anchors: DistillSample[]
  /** 冲突出处（同键两侧出现——正常为空；非空 = 切分实现 bug，直接抛错的上游证据）。 */
  conflicts: string[]
  droppedDuplicate: number
}

/** 切分主流程：出处级归属 → 内容级跨侧去重（held-out 优先保留）。 */
export function packSplit(options: PackOptions): PackResult {
  const { core, anchors, heldoutProvenance } = options
  const train: DistillSample[] = []
  const heldout: DistillSample[] = []
  const seenHash = new Set<string>()
  let droppedDuplicate = 0

  // held-out 先入（内容级冲突时 held-out 优先，训练侧丢弃重复 context）
  for (const sample of core) {
    const key = provenanceKey(sample)
    if (key === null || !heldoutProvenance.has(key)) continue
    const h = contextHash(sample)
    if (seenHash.has(h)) {
      droppedDuplicate++
      continue
    }
    seenHash.add(h)
    heldout.push(sample)
  }
  for (const sample of core) {
    const key = provenanceKey(sample)
    const isHeldout = key !== null && heldoutProvenance.has(key)
    if (isHeldout) continue
    const h = contextHash(sample)
    if (seenHash.has(h)) {
      droppedDuplicate++
      continue
    }
    seenHash.add(h)
    train.push(sample)
  }

  // 出处冲突自检：同键不得跨侧（切分实现 bug 防线）
  const trainKeys = new Set(train.map((s) => provenanceKey(s)).filter((k): k is string => !!k))
  const conflicts = heldout.map((s) => provenanceKey(s)).filter((k): k is string => !!k && trainKeys.has(k))

  return { train, heldout, anchors, conflicts, droppedDuplicate }
}

/* ── 统计（数据卡）───────────────────────────────────────── */

export interface SourceStats {
  count: number
  byTurnType: Record<string, number>
  byStory: Record<string, number>
  multiStep: number
  toolCallSamples: number
  promptTokens: number
  completionTokens: number
  calls: number
}

export function computeStats(samples: DistillSample[]): SourceStats {
  const stats: SourceStats = {
    count: samples.length,
    byTurnType: {},
    byStory: {},
    multiStep: 0,
    toolCallSamples: 0,
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
  }
  for (const s of samples) {
    stats.byTurnType[s.meta.turnType] = (stats.byTurnType[s.meta.turnType] ?? 0) + 1
    stats.byStory[s.meta.storyName] = (stats.byStory[s.meta.storyName] ?? 0) + 1
    if (s.meta.multiStep) stats.multiStep++
    if (s.meta.toolCallCount > 0) stats.toolCallSamples++
    stats.promptTokens += s.meta.usage.promptTokens
    stats.completionTokens += s.meta.usage.completionTokens
    stats.calls += s.meta.usage.calls
  }
  return stats
}

/** 24 工具在最终数据中的出现覆盖（数据卡披露；与 #39 的期望覆盖是两回事）。 */
export function toolAppearance(samples: DistillSample[]): { tool: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const s of samples) {
    for (const m of s.messages as { role: string; tool_calls?: { function?: { name?: string } }[] }[]) {
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }
  return COC_TOOL_NAMES.map((t) => ({ tool: t, count: counts.get(t) ?? 0 }))
}

/* ── 分层抽检包（用户人工抽检 ≥50 条的动作入口）────────────────────────── */

export interface AuditPack {
  manifest: { id: string; source: string; turnType: string; storyName: string }[]
  checklistMarkdown: string
  /** data.js 内容（window.AUDIT_DATA = …；查看器模板同目录加载）。 */
  dataJs: string
}

/** 分层抽样：source × turnType 每层至多 perStratum 条，凑满 target 总量。 */
export function stratifyAudit(samples: DistillSample[], target = 60, perStratum = 4): DistillSample[] {
  const strata = new Map<string, DistillSample[]>()
  for (const s of samples) {
    const key = `${s.meta.source}:${s.meta.turnType}`
    const list = strata.get(key) ?? []
    list.push(s)
    strata.set(key, list)
  }
  const picked: DistillSample[] = []
  for (const [, list] of strata) {
    picked.push(...list.slice(0, perStratum))
    if (picked.length >= target) break
  }
  // 层内不足时从剩余样本顺序补齐
  if (picked.length < target) {
    const pickedIds = new Set(picked.map((s) => s.meta.id))
    for (const s of samples) {
      if (picked.length >= target) break
      if (!pickedIds.has(s.meta.id)) {
        picked.push(s)
        pickedIds.add(s.meta.id)
      }
    }
  }
  return picked.slice(0, target)
}

/** 生成抽检包：清单 + 勾选 markdown + data.js 数据文件（查看器为仓库静态模板
 *  training/data/audit-viewer.html，audit 阶段拷贝到同目录后经
 *  `<script src="data.js">` 加载数据——管线不生成任何 HTML）。 */
export function buildAuditPack(selected: DistillSample[]): AuditPack {
  const manifest = selected.map((s) => ({
    id: s.meta.id,
    source: s.meta.source,
    turnType: s.meta.turnType,
    storyName: s.meta.storyName,
  }))

  const checklistLines = [
    '# 人工抽检清单（票 #40 验收 4）',
    '',
    '> 逐条判读：叙事风格（洛夫克拉夫特式氛围/不剧透/描述证据而非结论）与质量（工具调用合理、参数与卡面一致、无文字骰点）。',
    '> 查看器：打开同目录 viewer.html（离线可读完整对话；数据来自同目录 data.js）。',
    '',
    '| # | id | 来源 | 回合类型 | 故事 | 判定 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...selected.map((s, i) => `| ${i + 1} | ${s.meta.id} | ${s.meta.source} | ${s.meta.turnType} | ${s.meta.storyName} | ☐ 合格 / ☐ 不合格 | |`),
  ]
  const checklistMarkdown = checklistLines.join('\n')

  const payload = selected.map((s) => ({
    meta: s.meta,
    messages: (s.messages as { role: string; content: string; tool_calls?: { function: { name: string; arguments: string } }[]; tool_call_id?: string }[]).map((m) => ({
      role: m.role,
      content: m.content,
      toolNames: (m.tool_calls ?? []).map((t) => t.function.name),
      toolCallId: m.tool_call_id,
    })),
  }))
  // data.js 以脚本赋值承载 JSON（file:// 下 fetch 不可用）；转义 </script>
  // 闭合与 U+2028/2029 行分隔符，防样本内容破坏 JS 字面量
  const payloadJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  const dataJs = `window.AUDIT_DATA = ${payloadJson};\n`

  return { manifest, checklistMarkdown, dataJs }
}
