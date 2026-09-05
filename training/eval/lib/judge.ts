/**
 * 金样本判定器（T3 #39）：给定样本 + 模型响应 → 格式遵循 / 裁定正确 / 失败分类。
 *
 * 两个指标的语义（spec #36 Testing Decisions）：
 *  - 格式遵循 = 线上 validate 节点同源规则：工具名已知且参数 JSON 可解析、
 *    叙事正文无文字模拟骰子、required 工具覆盖（等价展开）。
 *  - 裁定正确 = 命中任一期望调用序列（有序子列 + 参数子集匹配）。
 * 失败分类（票 #39）：no_tool_call / wrong_tool / bad_args / text_dice，
 * 另有 unparseable（工具名未知或参数非 JSON 对象）。
 */
import { hasTextSimulation } from '../../../shared/tools/kpValidation.ts'
import { isKnownToolName, parseToolArguments, requiredToolsCovered, sequenceMatches, valueMatches } from './rules.ts'
import type { GoldenSample, ModelResponse, SampleJudgement } from './types.ts'

interface ParsedCall {
  name: string
  args: Record<string, unknown>
  raw: string
}

/** 归一化 openai_chat 响应 → { content, toolCalls } 并做可解析性检查。 */
export function parseResponse(response: ModelResponse): { calls: ParsedCall[]; unparseable: string[] } {
  const calls: ParsedCall[] = []
  const unparseable: string[] = []
  for (const tc of response.toolCalls ?? []) {
    const name = String(tc.name ?? '')
    if (!isKnownToolName(name)) {
      unparseable.push(`未知工具名: ${JSON.stringify(name)}`)
      continue
    }
    const args = parseToolArguments(tc.arguments)
    if (!args) {
      unparseable.push(`工具 ${name} 的 arguments 不是可解析 JSON 对象: ${JSON.stringify(String(tc.arguments ?? '').slice(0, 120))}`)
      continue
    }
    calls.push({ name, args, raw: String(tc.arguments ?? '') })
  }
  return { calls, unparseable }
}

/** 判定一个样本。 */
export function judgeSample(sample: GoldenSample, response: ModelResponse): SampleJudgement {
  const { calls, unparseable } = parseResponse(response)
  const content = String(response.content ?? '')

  // F1 可解析性（工具名已知 + arguments 为 JSON 对象）
  if (unparseable.length > 0) {
    return { id: sample.id, formatOk: false, verdictOk: false, category: 'unparseable', detail: unparseable.join('；') }
  }

  // F2 文字模拟骰子（validate 同源正则）
  if (hasTextSimulation(content)) {
    const snippet = content.slice(0, 160)
    return { id: sample.id, formatOk: false, verdictOk: false, category: 'text_dice', detail: `叙事正文命中文字模拟骰子正则: 「${snippet}…」` }
  }

  const actualNames = calls.map((c) => c.name)

  // 纯叙事样本：正文无文字骰点即可，调用工具 = 调错工具
  if (sample.expect.noTools) {
    if (calls.length > 0) {
      return {
        id: sample.id,
        formatOk: true,
        verdictOk: false,
        category: 'wrong_tool',
        detail: `纯叙事情境不应调用工具，实际调用了: ${actualNames.join(', ')}`,
      }
    }
    return { id: sample.id, formatOk: true, verdictOk: true, category: 'pass', detail: '' }
  }

  // F3 required 工具覆盖（与 validate 节点同语义：等价展开后逐一在场）
  if (!requiredToolsCovered(actualNames, sample)) {
    if (calls.length === 0) {
      return {
        id: sample.id,
        formatOk: false,
        verdictOk: false,
        category: 'no_tool_call',
        detail: `应调用工具但未调用任何工具（期望其一: ${sample.expect.alternatives.map((s) => s.map((c) => c.name).join('+')).join(' | ')}）`,
      }
    }
    return {
      id: sample.id,
      formatOk: false,
      verdictOk: false,
      category: 'wrong_tool',
      detail: `调用的工具不在期望集合内（实际: ${actualNames.join(', ')}；期望其一: ${sample.expect.alternatives.map((s) => s.map((c) => c.name).join('+')).join(' | ')}）`,
    }
  }

  // 裁定：命中任一期望序列（有序子列 + 参数子集）
  for (const seq of sample.expect.alternatives) {
    if (sequenceMatches(calls, seq)) {
      return { id: sample.id, formatOk: true, verdictOk: true, category: 'pass', detail: '' }
    }
  }

  // 工具对了但参数不匹配 → 给出首个期望调用的参数差异明细（用与裁定器同一的
  // 匹配语义 valueMatches，避免明细报出裁定语义本可通过的「假差异」）
  const first = sample.expect.alternatives[0]?.[0]
  const actualOfExpected = first ? calls.find((c) => c.name === first.name) : undefined
  const diff = first && actualOfExpected ? describeArgsDiff(actualOfExpected.args, first.args ?? {}) : '（未找到同名工具调用）'
  return {
    id: sample.id,
    formatOk: true,
    verdictOk: false,
    category: 'bad_args',
    detail: `工具已调用但参数不匹配期望。${first ? `期望 ${first.name}: ${JSON.stringify(first.args ?? {})}；` : ''}差异: ${diff}`,
  }
}

function describeArgsDiff(actual: Record<string, unknown>, expected: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) parts.push(`缺参数 ${k}`)
    else if (!valueMatches(actual[k], v)) parts.push(`${k}: 期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(actual[k])}`)
  }
  return parts.length ? parts.join('；') : '参数表层一致（可能其余键值不符）'
}
