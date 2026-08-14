/**
 * COC-specialized local search prompt.
 * Based on Microsoft GraphRAG local_search prompt.
 * Used when querying about specific entities/context.
 *
 * Migrated verbatim from original/ai-trpg-web/electron/rag/prompts/cocLocalSearch.js.
 */
export function buildLocalSearchPrompt({
  contextData,
  query,
  responseType = 'multiple paragraphs',
}: {
  contextData: string
  query: string
  responseType?: string
}): string {
  return `You are a game master (KP) assistant for Call of Cthulhu TRPG. Based on the following story knowledge graph context, answer the query to help narrate the scenario.

CONTEXT (entities, relationships, community summaries):
---
${contextData}
---

QUERY: ${query}

Provide a ${responseType} response that synthesizes the relevant information for the KP.`
}
