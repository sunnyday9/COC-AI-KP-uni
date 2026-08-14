import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

import cocToolNames from '../cocToolNames.json'
import { checkHandler } from '../handlers/checkHandler'
import { combatHandler } from '../handlers/combatHandler'
import { sanityHandler } from '../handlers/sanityHandler'
import { resourceHandler } from '../handlers/resourceHandler'
import { narrativeHandler } from '../handlers/narrativeHandler'

const require = createRequire(import.meta.url)
const { COC_KP_TOOLS } = require('../../../../shared/tools/cocTools.cjs') as {
  COC_KP_TOOLS: Array<{ function?: { name?: string } }>
}

function toSet(list: string[]): Set<string> {
  return new Set(list.filter((s) => typeof s === 'string' && s.length > 0))
}

function expectSameSet(a: Set<string>, b: Set<string>) {
  const onlyA = [...a].filter((x) => !b.has(x)).sort()
  const onlyB = [...b].filter((x) => !a.has(x)).sort()
  expect({ onlyA, onlyB }).toEqual({ onlyA: [], onlyB: [] })
}

describe('toolCalling: tool name consistency', () => {
  it('backend tools, tool name list, and renderer handlers match exactly', () => {
    const backend = toSet(
      (COC_KP_TOOLS || [])
        .map((t) => String(t?.function?.name ?? '').trim())
        .filter(Boolean)
    )

    const list = toSet((cocToolNames as unknown as string[]) ?? [])

    const handlerNames = toSet([
      ...checkHandler.toolNames,
      ...combatHandler.toolNames,
      ...sanityHandler.toolNames,
      ...resourceHandler.toolNames,
      ...narrativeHandler.toolNames,
    ])

    // No duplicates in the source-of-truth list.
    expect((cocToolNames as unknown as string[]).length).toBe(list.size)

    expectSameSet(backend, list)
    expectSameSet(handlerNames, list)
  })
})

