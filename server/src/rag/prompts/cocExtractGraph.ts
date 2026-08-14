/**
 * COC (Call of Cthulhu) specialized entity/relationship extraction prompt.
 * Based on Microsoft GraphRAG extract_graph prompt structure.
 * Tokens: {entity_types}, {input_text}, {completion_delimiter}, {record_delimiter}, {tuple_delimiter}
 *
 * Migrated verbatim from original/ai-trpg-web/electron/rag/prompts/cocExtractGraph.js.
 */
export const COC_ENTITY_TYPES = [
  'scene',      // 场景 - story location/setting
  'clue',       // 线索 - evidence, key item for progression
  'npc',        // 人物/NPC - character, investigator, creature
  'location',   // 地点 - place, building, region
  'item',       // 物品 - object, artifact, document
  'event',      // 事件 - plot event, incident
  'organization', // 组织 - cult, group, institution
  'creature',   // 神秘实体 - mythos entity, monster
]

export const COC_RELATIONSHIP_TYPES = [
  'located_in',   // 位于
  'contains',     // 包含
  'triggers',     // 触发
  'unlocks',      // 解锁
  'depends_on',   // 依赖
  'mentions',     // 提及
  'participates', // 参与
  'belongs_to',   // 属于
  'transitions_to', // 前往/进入
]

export interface ExtractGraphPromptParams {
  inputText: string
  entityTypes?: string[]
}

export function buildExtractGraphPrompt({ inputText, entityTypes = COC_ENTITY_TYPES }: ExtractGraphPromptParams): string {
  const recordDelimiter = '\n'
  const tupleDelimiter = ' | '
  const completionDelimiter = '---END---'

  return `You are a knowledge graph extractor for Call of Cthulhu (COC) TRPG scenarios. Extract entities and relationships from the story text.

ENTITY TYPES to extract: ${entityTypes.join(', ')}

For each ENTITY, output a line with: entity_name ${tupleDelimiter} entity_type ${tupleDelimiter} brief_description
For each RELATIONSHIP, output a line with: source_entity ${tupleDelimiter} target_entity ${tupleDelimiter} relationship_type ${tupleDelimiter} brief_description

Relationship types: located_in, contains, triggers, unlocks, depends_on, mentions, participates, belongs_to, transitions_to

Output format: one entity or relationship per line. Use "${tupleDelimiter}" to separate fields. Output ${completionDelimiter} when done.

INPUT TEXT:
---
${inputText}
---

Output:`
}

export function getCompletionDelimiter(): string {
  return '---END---'
}

export interface ExtractedEntity {
  name: string
  type: string
  description: string
}

export interface ExtractedRelation {
  source: string
  target: string
  type: string
  description: string
}

export interface ExtractOutput {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
}

export function parseExtractOutput(text: string): ExtractOutput {
  const raw = (text || '').trim()
  const jsonMatch = raw.match(/\{[\s\S]*"entities"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      // Cast-only: runtime behavior identical to the original (fields used as-is)
      const j = JSON.parse(jsonMatch[0]) as {
        entities?: { name: string; type: string; description?: string }[]
        relations?: { source: string; target: string; type: string; description?: string }[]
      }
      return {
        entities: (j.entities || []).map((e) => ({ name: e.name, type: e.type, description: e.description || '' })),
        relations: (j.relations || []).map((r) => ({ source: r.source, target: r.target, type: r.type, description: r.description || '' })),
      }
    } catch {
      /* fall through to pipe format */
    }
  }

  const tupleDelimiter = ' | '
  const rawBody = raw.split('---END---')[0].trim()
  const lines = rawBody.split('\n').map((l) => l.trim()).filter(Boolean)
  const entities: ExtractedEntity[] = []
  const relations: ExtractedRelation[] = []

  const relTypes = new Set(COC_RELATIONSHIP_TYPES.map((t) => t.toLowerCase()))
  const entityTypes = new Set(COC_ENTITY_TYPES.map((t) => t.toLowerCase()))

  for (const line of lines) {
    const parts = line.split(tupleDelimiter).map((p) => p.trim())
    if (parts.length === 3) {
      const mid = parts[1].toLowerCase()
      if (relTypes.has(mid)) {
        relations.push({ source: parts[0], target: parts[2], type: parts[1], description: '' })
      } else {
        entities.push({ name: parts[0], type: parts[1], description: parts[2] })
      }
    } else if (parts.length >= 4) {
      relations.push({
        source: parts[0],
        target: parts[1],
        type: parts[2],
        description: parts[3] || '',
      })
    }
  }
  return { entities, relations }
}
