import { describe, expect, it } from 'vitest'

import { COC_TOOL_NAMES } from '../../../../shared/tools/cocTools'
import { checkHandler } from '../handlers/checkHandler'
import { combatHandler } from '../handlers/combatHandler'
import { sanityHandler } from '../handlers/sanityHandler'
import { resourceHandler } from '../handlers/resourceHandler'
import { narrativeHandler } from '../handlers/narrativeHandler'

/**
 * Tool name consistency (Task 10 单一来源化后改版):
 * 数据源从 `cocToolNames.json` + `require(shared/tools/cocTools.cjs)` 双来源
 * 改为唯一的 `shared/tools/cocTools.ts` 导出 COC_TOOL_NAMES（server COC_KP_TOOLS
 * 同源）。原断言「json 与后端工具名集合一致」退化为同源自比较，因此测试语义改为：
 * 1) COC_TOOL_NAMES 无重复（server 端工具定义逐字迁移的守卫）；
 * 2) client 全部 handler 覆盖的工具名与 COC_TOOL_NAMES 完全一致（无遗漏、无多余）。
 */
function toSet(list: string[]): Set<string> {
  return new Set(list.filter((s) => typeof s === 'string' && s.length > 0))
}

function expectSameSet(a: Set<string>, b: Set<string>) {
  const onlyA = [...a].filter((x) => !b.has(x)).sort()
  const onlyB = [...b].filter((x) => !a.has(x)).sort()
  expect({ onlyA, onlyB }).toEqual({ onlyA: [], onlyB: [] })
}

describe('toolCalling: tool name consistency', () => {
  it('COC_TOOL_NAMES (shared single source) has no duplicates', () => {
    const list = toSet(COC_TOOL_NAMES)
    expect(COC_TOOL_NAMES.length).toBe(list.size)
  })

  it('renderer handler tool names match COC_TOOL_NAMES exactly', () => {
    const list = toSet(COC_TOOL_NAMES)

    const handlerNames = toSet([
      ...checkHandler.toolNames,
      ...combatHandler.toolNames,
      ...sanityHandler.toolNames,
      ...resourceHandler.toolNames,
      ...narrativeHandler.toolNames,
    ])

    expectSameSet(handlerNames, list)
  })
})
