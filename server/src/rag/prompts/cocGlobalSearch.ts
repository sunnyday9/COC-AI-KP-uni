/**
 * COC-specialized global search prompt.
 * Based on Microsoft GraphRAG global_search prompt.
 * Used for holistic questions about the entire story.
 *
 * Migrated verbatim from original/ai-trpg-web/electron/rag/prompts/cocGlobalSearch.js.
 */
export function buildGlobalSearchPrompt({
  contextData,
  query,
  responseType = 'multiple paragraphs',
}: {
  contextData: string
  query: string
  responseType?: string
}): string {
  return `You are a game master (KP) assistant for Call of Cthulhu TRPG. The following is a holistic summary of the scenario's knowledge graph (entities, relationships, community reports).

Use this context to answer the query for narrative and plot guidance.

CONTEXT:
---
${contextData}
---

QUERY: ${query}

Provide a ${responseType} response.`
}
