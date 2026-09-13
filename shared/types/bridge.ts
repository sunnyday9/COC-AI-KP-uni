/**
 * Platform bridge wire payload types — the shapes exchanged between
 * `client/src/platform/bridge.ts` (PlatformBridge) and the server endpoints
 * (docs/api-contract.md §9). The method-level contract is the PlatformBridge
 * implementation itself (the decorative `Bridge` interface was retired in
 * #80); this file only holds cross-end payload/param types.
 */
export type Platform = 'h5' | 'mp-weixin' | 'app'

export interface BridgeUser {
  id: string
  username: string
}

export interface AuthResult {
  token: string
  user: BridgeUser
}

/** 索引一个故事：切块在服务端完成，客户端只报 storyId（M1-T3 / issue #48）。 */
export interface RAGIndexParams {
  scriptId: string
  storyMeta?: { name?: string }
}

export interface RAGContextParams {
  query: string
  scriptId?: string
  sceneId?: string
  topK?: number
}

export interface RAGQueryParams {
  query: string
  scriptId?: string
  sceneId?: string
  type?: string
  topK?: number
}

export interface IndexedStory {
  storyId: string
  name: string
  chunkCount: number
  indexedAt: number
}

/** GET /api/rag/index/:scriptId 响应（原 Bridge.ragGetIndex 返回形状，#80 升格为具名 wire 类型）。 */
export interface RagGetIndexResult {
  scriptId: string
  storyName: string
  chunkCount: number
  chunks: { id: string; content: string; type: string; metadata: Record<string, unknown>; hasVector: boolean }[]
}
