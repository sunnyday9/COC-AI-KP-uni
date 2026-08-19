/**
 * Tool name consistency — 迁自 client/src/toolCalling/__tests__/toolConsistency.spec.ts
 * （Phase A1 规则引擎下沉）。数据源为唯一的 shared/tools/cocTools.ts（COC_TOOL_NAMES）。
 * 语义：1) COC_TOOL_NAMES 无重复；2) 全部 handler 覆盖的工具名与 COC_TOOL_NAMES 完全一致。
 */
import { describe, expect, it } from 'vitest'

import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.js'
import { checkHandler } from '../../src/rule-engine/handlers/checkHandler.js'
import { combatHandler } from '../../src/rule-engine/handlers/combatHandler.js'
import { sanityHandler } from '../../src/rule-engine/handlers/sanityHandler.js'
import { resourceHandler } from '../../src/rule-engine/handlers/resourceHandler.js'
import { narrativeHandler } from '../../src/rule-engine/handlers/narrativeHandler.js'
import { rulesHandler } from '../../src/rule-engine/handlers/rulesHandler.js'

function toSet(list: string[]): Set<string> {
  return new Set(list.filter((s) => typeof s === 'string' && s.length > 0))
}

function expectSameSet(a: Set<string>, b: Set<string>) {
  const onlyA = [...a].filter((x) => !b.has(x)).sort()
  const onlyB = [...b].filter((x) => !a.has(x)).sort()
  expect({ onlyA, onlyB }).toEqual({ onlyA: [], onlyB: [] })
}

describe('rule-engine: tool name consistency', () => {
  it('COC_TOOL_NAMES (shared single source) has no duplicates', () => {
    const list = toSet(COC_TOOL_NAMES)
    expect(COC_TOOL_NAMES.length).toBe(list.size)
  })

  it('handler tool names match COC_TOOL_NAMES exactly', () => {
    const list = toSet(COC_TOOL_NAMES)

    const handlerNames = toSet([
      ...checkHandler.toolNames,
      ...combatHandler.toolNames,
      ...sanityHandler.toolNames,
      ...resourceHandler.toolNames,
      ...narrativeHandler.toolNames,
      ...rulesHandler.toolNames,
    ])

    expectSameSet(handlerNames, list)
  })
})
