/**
 * 客观判定原语（T3 #39）。
 *
 * 格式遵循的判定基础 = shared/tools/kpValidation.ts 的 validate 规则（与
 * server/src/agent/kpGraph.ts validate 节点同源单点）：required 工具覆盖
 * （含 melee/ranged_attack 等价展开）+ 文字模拟骰子正则。本模块只追加
 * 评测侧需要的参数匹配原语（子集匹配 + 数组包含 + 数字宽化），不复制规则。
 */
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.ts'
import { coversRequiredTools } from '../../../shared/tools/kpValidation.ts'
import type { ExpectedCall, GoldenSample } from './types.ts'

export function isKnownToolName(name: string): boolean {
  return COC_TOOL_NAMES.includes(name)
}

/** 工具结果「可解析」：arguments 非空且 JSON.parse 后是对象。 */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (!raw || !String(raw).trim()) return null
  try {
    const v = JSON.parse(String(raw)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function scalarEqual(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') {
    const n = Number(actual)
    return Number.isFinite(n) && n === expected
  }
  if (typeof expected === 'boolean') return actual === expected
  if (typeof expected === 'string') return String(actual).trim() === expected.trim()
  if (expected === null || expected === undefined) return actual === null || actual === undefined
  return false
}

/** 结构匹配：对象按子集、数组按「期望每个元素都能在实际数组中找到深匹配」。 */
export function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    return expected.every((e) => actual.some((a) => valueMatches(a, e)))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => valueMatches((actual as Record<string, unknown>)[k], v))
  }
  return scalarEqual(actual, expected)
}

/** 期望调用匹配：name 相等 + args 子集匹配 + forbid 的键值对不得出现。 */
export function expectedCallMatches(call: { name: string; args: Record<string, unknown> }, expected: ExpectedCall): boolean {
  if (call.name !== expected.name) return false
  if (expected.args) {
    for (const [k, v] of Object.entries(expected.args)) {
      if (!(k in call.args) || !valueMatches(call.args[k], v)) return false
    }
  }
  if (expected.forbid) {
    for (const [k, v] of Object.entries(expected.forbid)) {
      if (k in call.args && valueMatches(call.args[k], v)) return false
    }
  }
  return true
}

/** 有序子列匹配：期望序列按顺序在实际调用中出现（允许中间夹额外调用）。 */
export function sequenceMatches(actual: { name: string; args: Record<string, unknown> }[], expectedSeq: ExpectedCall[]): boolean {
  let idx = 0
  for (const call of actual) {
    if (idx < expectedSeq.length && expectedCallMatches(call, expectedSeq[idx])) idx++
  }
  return idx === expectedSeq.length
}

/** required 工具覆盖：至少一条备选序列的工具名集合（经等价展开）全部在场。 */
export function requiredToolsCovered(actualNames: string[], sample: GoldenSample): boolean {
  if (sample.expect.noTools) return true
  return sample.expect.alternatives.some((seq) => coversRequiredTools(actualNames, seq.map((c) => c.name)).missing.length === 0)
}
