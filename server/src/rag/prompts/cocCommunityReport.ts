/**
 * COC-specialized community report prompt.
 * Based on Microsoft GraphRAG community_report prompt.
 * Summarizes a community (connected subgraph) for holistic context.
 *
 * Migrated verbatim from original/ai-trpg-web/electron/rag/prompts/cocCommunityReport.js.
 */
export function buildCommunityReportPrompt({ inputText }: { inputText: string }): string {
  return `You are summarizing a subgraph from a Call of Cthulhu (COC) TRPG scenario. The following tables contain entities and relationships from a connected community in the story.

Generate a concise report (2-4 paragraphs) that:
1. Describes the key entities (scenes, clues, NPCs, locations, items) and their roles
2. Explains the relationships and how they connect (unlocks, triggers, dependencies)
3. Highlights plot-relevant information for a game master (KP) to narrate

INPUT:
---
${inputText}
---

Report:`
}
