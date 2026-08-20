/**
 * Platform Bridge interface — mirrors docs/api-contract.md §9 (客户端 Bridge 映射).
 * Method signatures are modeled on the original `window.electronAPI`
 * (original/ai-trpg-web/src/env.d.ts), with `path`-based params replaced by
 * server-generated `id`s and new auth methods added.
 */
import type { AppSettings } from './settings'

export type Platform = 'h5' | 'mp-weixin' | 'app'

export interface BridgeUser {
  id: string
  username: string
}

export interface AuthResult {
  token: string
  user: BridgeUser
}

export interface RAGIndexParams {
  scriptId: string
  chunks: { id: string; content: string; type: string; metadata: Record<string, unknown> }[]
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

export interface ToolCallResult {
  id: string
  name: string
  arguments: string
}

export interface KpStreamPayload {
  streamId: string
  type: 'chunk' | 'end' | 'error' | 'trace'
  chunk?: string
  content?: string
  toolCalls?: ToolCallResult[]
  /** Phase A2: 服务端图内工具循环 — 工具产生的骰子/系统展示消息。 */
  displayMessages?: unknown[]
  /** Phase A2: 服务端工具执行产生的世界增量（线索/场景/结局）。 */
  worldDeltas?: {
    cluesAdded?: { description: string; clueId?: string }[]
    sceneChanged?: string
    ending?: unknown
  }
  /** Phase A2: 服务端更新后的角色卡快照。 */
  characterSheet?: unknown
  error?: string
  traceEvents?: unknown[]
}

export interface Bridge {
  platform: Platform

  // ── Auth（新增）───────────────────────────────────────────────
  login: (params: { username: string; password: string }) => Promise<AuthResult>
  register: (params: { username: string; password: string }) => Promise<AuthResult>
  logout: () => Promise<void>
  me: () => Promise<{ user: BridgeUser }>

  // ── Settings（替代 electron-store）────────────────────────────
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: AppSettings) => Promise<{ ok: true }>

  // ── Stories（id 替代原 path）───────────────────────────────────
  listStories: () => Promise<{ name: string; id: string }[]>
  readStory: (id: string) => Promise<string>
  readStoryForRag: (id: string) => Promise<string>
  importStory: () => Promise<{ ok: boolean; error?: string; id?: string; name?: string }>
  deleteStory: (id: string) => Promise<void>

  // ── Scripts（原 scripts 库，id 替代原 path）────────────────────
  listScripts: () => Promise<{ name: string; id: string }[]>
  readScript: (id: string) => Promise<string>
  saveScript: (id: string, content: string) => Promise<{ ok: boolean }>
  saveScriptToLibrary: (name: string, content: string) => Promise<{ ok: boolean; id?: string }>
  deleteScript: (id: string) => Promise<void>
  importScript: () => Promise<{ ok: boolean; name?: string; id?: string }>

  // ── AI（API Key 仅服务端持有）──────────────────────────────────
  aiChat: (params: {
    messages: { role: string; content: string }[]
    temperature?: number
    maxTokens?: number
    stream?: boolean
  }) => Promise<{ stream: boolean; content?: string; chunks?: string[] }>
  aiListModels: (params: { purpose?: 'chat' | 'embeddings' }) => Promise<{ value: string; label: string }[]>

  // ── KP Agent（LangGraph）──────────────────────────────────────
  kpInvoke: (params: {
    messages: { role: string; content: string }[]
  }) => Promise<{ content?: string; toolCalls?: ToolCallResult[] }>
  kpInvokeStream: (params: { messages: { role: string; content: string }[] }) => Promise<{ streamId: string }>
  onKpStream: (handler: (payload: KpStreamPayload) => void) => () => void

  // ── Saves ─────────────────────────────────────────────────────
  listSaves: () => Promise<string[]>
  readSave: (saveId: string) => Promise<unknown>
  writeSave: (saveId: string, data: unknown) => Promise<void>

  // ── Rooms（Phase B3 多人联机）─────────────────────────────────
  roomCreate?: (storyId?: string) => Promise<{ ok: boolean; roomId: string; inviteCode: string; ownerId: number; ownerName: string }>
  roomList?: () => Promise<{ roomId: string; inviteCode: string; storyId: string | null; phase: string; updatedAt: number }[]>
  roomJoin?: (inviteCode: string) => Promise<{ ok: boolean; roomId: string }>
  roomDetail?: (roomId: string) => Promise<{
    roomId: string
    inviteCode: string
    storyId: string | null
    phase: string
    ownerId: number
    members: { userId: number; username: string; role: string; characterId: string | null }[]
    state: Record<string, unknown>
    createdAt: number
  }>
  roomStart?: (roomId: string, storyId: string) => Promise<{ ok: boolean }>
  roomBindCharacter?: (roomId: string, characterId: string) => Promise<{ ok: boolean }>
  roomDelete?: (roomId: string) => Promise<{ ok: boolean }>
  onRoomFrame?: (handler: (frame: unknown) => void) => () => void
  sendRoomFrame?: (type: 'room:join' | 'room:leave' | 'room:sync' | 'room:action', body: Record<string, unknown>) => void

  // ── Characters（Phase B4 角色卡持久化）───────────────────────
  characterCreate?: (name: string, sheet: unknown) => Promise<{ ok: boolean; id: string; name: string }>
  characterList?: () => Promise<{ id: string; name: string; sheet: Record<string, unknown>; updatedAt: number }[]>
  characterDetail?: (id: string) => Promise<{ id: string; name: string; sheet: Record<string, unknown>; updatedAt: number }>
  characterDelete?: (id: string) => Promise<{ ok: boolean }>

  // ── RAG（与 ragHandlers.cjs 一致）─────────────────────────────
  ragHealth: () => Promise<{ status: string; service: string }>
  ragTestEmbedding: () => Promise<{ ok: boolean; vectorLength?: number; error?: string }>
  ragTestGraphRagExtract: (params: { scriptId: string; maxChunks?: number; maxBatches?: number }) => Promise<{
    ok: boolean
    scriptId?: string
    extractionModelUsed?: string | null
    totalBatches?: number
    testedBatches?: number
    results?: {
      batchIndex: number
      chunkIds: string[]
      extractionModelUsed?: string | null
      rawOutputPreview?: string
      hasTupleDelimiter?: boolean
      entitiesCount?: number
      relationsCount?: number
      entitiesSample?: { name: string; type: string }[]
      relationsSample?: { source: string; target: string; type: string }[]
      error?: string
    }[]
    error?: string
  }>
  ragIndex: (params: RAGIndexParams) => Promise<{ ok: boolean; indexed: number }>
  ragDelete: (scriptId: string) => Promise<{ ok: boolean; deleted: number }>
  ragQuery: (params: RAGQueryParams) => Promise<{ chunks: { content: string; metadata: Record<string, string>; distance: number }[] }>
  ragContext: (params: RAGContextParams) => Promise<{ context: string; graphSummary?: string; chunkCount?: number }>
  ragListStories: () => Promise<IndexedStory[]>
  ragStoryOverview: (params: { storyId: string; topK?: number }) => Promise<{ overview: string; storyName: string }>
  ragGetIndex: (params: { scriptId: string }) => Promise<{
    scriptId: string
    storyName: string
    chunkCount: number
    chunks: { id: string; content: string; type: string; metadata: Record<string, unknown>; hasVector: boolean }[]
  }>
  ragGetGraph: (params: { scriptId: string }) => Promise<{
    scriptId: string
    storyName: string
    indexedAt: number
    nodeCount: number
    edgeCount: number
    nodes: { id: string; type: string; name: string; content: string; communityId: string | null; chunkIds: string[] }[]
    edges: { source: string; target: string; type: string; label: string }[]
    communitySummaries: Record<string, string>
  } | null>

  // ── RAG 用户行动图谱（可选，Task 3+ 填充）────────────────────
  ragUserGraphAdd?: (params: {
    storyId: string
    sessionId: string
    event: { type: string; name: string; description?: string }
  }) => Promise<{ ok: boolean }>
  ragUserGraphSync?: (params: {
    storyId: string
    sessionId: string
    state: { cluesObtained: { id: string; description: string }[]; currentScene: string }
  }) => Promise<{ ok: boolean }>
  ragUserGraphSummary?: (params: { storyId: string; sessionId: string }) => Promise<{ summary: string }>
}
