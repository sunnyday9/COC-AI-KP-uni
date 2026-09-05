/**
 * validate 自动过滤（T4）：蒸馏样本的格式底线机械化保证（spec #36 Testing
 * Decisions / 票 #40「validate 规则自动过滤」）。
 *
 * 规则单源 = shared/tools/kpValidation.ts（产品 validate 节点与 #39 评测同一份）：
 *  - 文字模拟骰子正则（hasTextSimulation）作用于每轮 assistant 叙事与最终叙事；
 *  - required 工具覆盖（coversRequiredTools + TOOL_EQUIVALENTS 等价展开）按回合
 *    类型契约判定（turnTypes.ts；required=[] = 纯叙事，要求零工具调用）；
 *  - 追加合成数据特有的机械检查：工具名在 24 工具名单内、参数可解析、工具结果
 *    非规则引擎 error、叙事非空、工具循环未打满上限。
 */
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.js'
import { coversRequiredTools, hasTextSimulation } from '../../../shared/tools/kpValidation.js'
import { parseToolArguments } from '../../eval/lib/rules.js'
import { TOOL_LOOP_MAX } from './types.js'
import { TURN_TYPE_SPECS } from './turnTypes.js'
import type { FilterVerdict, ReplayedTurn } from './types.js'

const MAX_TOOL_ITERATIONS = TOOL_LOOP_MAX

/** 过滤一个重放回合：首个失败即返回（分类见 FilterVerdict.category）。 */
export function filterTurn(turn: ReplayedTurn): FilterVerdict {
  const { skeleton, iterations, finalContent, hitCap } = turn

  if (hitCap) {
    return { ok: false, category: 'tool_overflow', detail: `工具循环打满 ${MAX_TOOL_ITERATIONS} 轮未收口` }
  }
  if (!finalContent.trim()) {
    return { ok: false, category: 'no_narrative', detail: '最终叙事为空' }
  }
  for (const it of iterations) {
    if (hasTextSimulation(it.assistantContent)) {
      return { ok: false, category: 'text_dice', detail: `工具循环轮叙事文字模拟骰子/数值：${it.assistantContent.slice(0, 80)}` }
    }
  }
  if (hasTextSimulation(finalContent)) {
    return { ok: false, category: 'text_dice', detail: `最终叙事文字模拟骰子/数值：${finalContent.slice(0, 80)}` }
  }

  const allCalls = iterations.flatMap((it) => it.toolCalls)
  const allNames = allCalls.map((t) => t.name)
  for (const tc of allCalls) {
    if (!COC_TOOL_NAMES.includes(tc.name)) {
      return { ok: false, category: 'unknown_tool', detail: `未知工具名: ${tc.name}` }
    }
    if (!parseToolArguments(tc.arguments)) {
      return { ok: false, category: 'bad_args', detail: `工具 ${tc.name} 参数不可解析: ${tc.arguments.slice(0, 80)}` }
    }
  }
  for (const it of iterations) {
    for (const tr of it.toolResults) {
      if (String(tr.content).startsWith('error')) {
        return { ok: false, category: 'tool_error', detail: `规则引擎执行失败: ${tr.content.slice(0, 120)}` }
      }
    }
  }

  const required = TURN_TYPE_SPECS[skeleton.turnType].required
  if (required !== null) {
    const { missing } = coversRequiredTools(allNames, required)
    if (missing.length > 0) {
      return { ok: false, category: 'missing_required', detail: `回合类型 ${skeleton.turnType} 缺 required 工具: ${missing.join(', ')}` }
    }
    if (required.length === 0 && allCalls.length > 0) {
      return { ok: false, category: 'missing_required', detail: `纯叙事回合（required=[]）不应有工具调用，实际: ${allNames.join(', ')}` }
    }
  }
  return { ok: true, category: 'pass', detail: 'pass' }
}
