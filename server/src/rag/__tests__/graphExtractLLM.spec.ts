// @vitest-environment node
/**
 * Migrated from original/ai-trpg-web/electron/rag/__tests__/graphExtractLLM.spec.ts.
 * No real LLM calls: invokeChat is a stub.
 */
import { describe, it, expect } from 'vitest'
import { extractGraphFromChunksLLM } from '../graphExtractLLM.js'
import { parseExtractOutput } from '../prompts/cocExtractGraph.js'

describe('rag/graphExtractLLM', () => {
  it('returns empty graph when no chunks', async () => {
    const result = await extractGraphFromChunksLLM({
      scriptId: 's1',
      chunks: [],
      invokeChat: async () => ({ content: '' }),
    })
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
  })

  it('extracts entities and relations from a mocked batch output', async () => {
    const result = await extractGraphFromChunksLLM({
      scriptId: 's1',
      chunks: [{ id: 'c1', content: '图书馆里藏着密信。' }, { id: 'c2', content: '密信指向医院。' }],
      invokeChat: async () => ({
        content: `图书馆 | scene | 调查员可搜索的场所\n密信 | clue | 关键线索\n图书馆 | contains | 密信\n---END---`,
      }),
    })
    expect(result.nodes.length).toBeGreaterThanOrEqual(2)
    expect(result.edges.length).toBeGreaterThanOrEqual(1)
    expect(result.chunkToNode.size).toBeGreaterThan(0)
  })

  it('parseExtractOutput handles pipe format', () => {
    const text = `图书馆 | scene | 调查员可搜索的场所
密信 | clue | 关键线索
图书馆 | contains | 密信
---END---`
    const { entities, relations } = parseExtractOutput(text)
    expect(entities).toHaveLength(2)
    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({ source: '图书馆', target: '密信', type: 'contains' })
  })

  it('parseExtractOutput handles JSON format', () => {
    const text = '{"entities":[{"name":"张三","type":"npc","description":"主角"}],"relations":[{"source":"张三","target":"图书馆","type":"located_in","description":""}]}'
    const { entities, relations } = parseExtractOutput(text)
    expect(entities).toHaveLength(1)
    expect(entities[0]!.name).toBe('张三')
    expect(relations).toHaveLength(1)
  })
})
