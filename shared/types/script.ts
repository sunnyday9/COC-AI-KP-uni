export interface RAGChunk {
  id: string
  content: string
  type: 'scene' | 'npc' | 'clue' | 'rule' | string
  metadata: {
    storyId?: string
    sceneId?: string
    npcId?: string
    clueId?: string
    chunkIndex?: number | string
  }
}
