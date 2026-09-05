import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.ts'
import { loadSamples, toolCoverage } from '../lib/runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLES = resolve(HERE, '../golden-samples.json')

test('金样本集：结构校验通过、无重复 id、每条带人工复核注记', () => {
  const samples = loadSamples(SAMPLES)
  assert.ok(samples.length >= 50, `金样本须 ≥50 条，实际 ${samples.length}`)
  const ids = new Set(samples.map((s) => s.id))
  assert.equal(ids.size, samples.length, 'id 不得重复')
  for (const s of samples) {
    assert.ok(s.notes.length > 0, `${s.id} 缺人工复核注记`)
    assert.ok(s.batchUserContent.length > 0, `${s.id} 缺玩家行动`)
  }
})

test('金样本集：24 工具全覆盖', () => {
  const samples = loadSamples(SAMPLES)
  const uncovered = toolCoverage(samples).filter((c) => !c.covered)
  assert.deepEqual(uncovered, [], `未覆盖工具: ${uncovered.map((c) => c.tool).join(', ')}`)
  assert.equal(COC_TOOL_NAMES.length, 24, '工具总数应为 24')
})

test('金样本集：续接样本的工具结果回填为线上同形态（【结果摘要】+JSON）', () => {
  const samples = loadSamples(SAMPLES)
  for (const s of samples) {
    for (const it of s.priorIterations ?? []) {
      assert.equal(it.toolCalls.length, it.toolResults.length, `${s.id}: toolCalls 与 toolResults 数量不一致`)
      for (const tr of it.toolResults) {
        assert.ok(tr.content.startsWith('【结果摘要】'), `${s.id}: 工具结果应带【结果摘要】头（线上同形态）`)
        assert.ok(tr.content.includes('{'), `${s.id}: 工具结果应含 JSON 体`)
      }
    }
  }
})

test('金样本集：多人样本的 characterId 与花名册一致', () => {
  const samples = loadSamples(SAMPLES)
  for (const s of samples) {
    if ((s.characters?.length ?? 0) < 2) continue
    assert.ok(s.charactersById && Object.keys(s.charactersById).length >= 2, `${s.id}: 多人样本应解析出 ≥2 张角色卡`)
    const expected = JSON.stringify(s.expect.alternatives)
    for (const id of s.characters ?? []) {
      if (expected.includes(id)) {
        assert.ok(Object.keys(s.charactersById).includes(id), `${s.id}: 期望参数引用的 ${id} 应在花名册内`)
      }
    }
  }
})
