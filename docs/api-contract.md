# API 契约（前后端唯一接口基准）

> 本契约镜像原 Electron `window.electronAPI`（见 `original/ai-trpg-web/src/env.d.ts`）的方法签名，
> 由 REST + WebSocket 实现。server（Task 2-5）与 client（Task 6-10）都以此文档为基准，禁止单边改动。
> 所有 `/api/*` 端点（除 `/api/auth/*` 外）需要 `Authorization: Bearer <JWT>`。

## 约定

- 所有请求/响应体均为 JSON（除文件上传 multipart 与文件下载）。
- 错误响应统一：`{ "error": string }` + 4xx/5xx 状态码。
- 原 IPC 中的绝对文件路径参数一律替换为服务端生成的 `id`（安全要求，禁止暴露路径）。

---

## 1. Auth（新增，Task 2）

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/auth/register` | `{ username, password }` | `{ token, user: { id, username } }` |
| POST | `/api/auth/login` | `{ username, password }` | `{ token, user: { id, username } }` |
| GET | `/api/auth/me` | — | `{ user: { id, username } }` |

- 密码 bcrypt 哈希；JWT 有效期 30 天；用户名 3-32 字符，密码 ≥6 字符。

## 2. Settings（Task 2）— 替代 electron-store

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/settings` | — | `AppSettings`（**不含 apiKey**，字段省略） |
| PUT | `/api/settings` | `AppSettings`（apiKey 仅在变更时传） | `{ ok: true }` |

```ts
interface AIProviderConfig {
  provider: string          // 'openai' | 'deepseek' | 'custom' | ... (见 PRESET_PROVIDERS)
  baseUrl: string
  model: string
  apiKey?: string           // 服务端 AES-256 加密存储；GET 不回传
  temperature: number
  maxTokens: number
}
interface RAGSettings {
  useEmbeddings: boolean
  provider: 'builtin' | 'api'
  model: string             // 默认 'text-embedding-3-small'
  useGraphRAG?: boolean
  extractionModel?: string
}
interface AppSettings {
  ai: AIProviderConfig
  rag?: RAGSettings
  syncServerUrl: string
  debugMode?: boolean
}
```

## 3. AI（Task 2）

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/ai/chat` | `{ messages: {role,content}[], temperature?, maxTokens?, stream? }` | `{ stream: boolean, content?: string, chunks?: string[] }` |
| GET | `/api/ai/models` | `?purpose=chat\|embeddings` | `{ value, label }[]` |

- AI 配置（provider/baseUrl/model/apiKey/temperature/maxTokens）**由服务端从用户设置读取**，请求体中不需要传。
- 流式：`stream=true` 时返回缓冲的 `chunks` 数组（与原 IPC 契约一致，真流式走 KP WebSocket 路径）。
- **安全约束**：服务端发起任何外部 URL 请求前必须校验 host —— 仅 http/https；拒绝 localhost、环回、私有（10/8、172.16/12、192.168/16、169.254/16）与保留地址（含 0.0.0.0、::、IPv6 映射）。实现于 `server/src/utils/outboundUrl.ts`。

## 4. KP Agent（Task 3）

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/kp/invoke` | `{ messages: {role,content}[] }` | `{ content?: string, toolCalls?: { id, name, arguments }[] }` |

- 非流式单次调用；KP Agent 状态机（LangGraph，9 意图）在服务端运行。
- 配置读取与 AI 相同（服务端设置）。

### WebSocket（替代 `onKpStream` / `kp:stream`）

- 端点：`ws://<host>/ws?token=<JWT>`（H5/App）；小程序走 `wss://`。
- 客户端 → 服务端消息：

```json
{ "type": "kp:invoke", "streamId": "uuid", "messages": [ { "role": "user", "content": "..." } ] }
```

- 服务端 → 客户端消息（payload 结构镜像 `onKpStream`）：

```json
{ "type": "chunk", "streamId": "...", "chunk": "..." }
{ "type": "end",   "streamId": "...", "content": "...", "toolCalls": [ { "id", "name", "arguments" } ] }
{ "type": "error", "streamId": "...", "error": "..." }
```

- 另有通用消息 `{ "type": "pong" }`（心跳响应）与 `{ "type": "rag:progress", "payload": {...} }`（RAG 索引进度，Task 4）。
- 单连接复用：客户端通过 `streamId` 区分多个并发请求；心跳 `{ "type": "ping" }` 每 30s。

## 5. 剧本 / 文件（Task 4）

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/stories` | — | `{ name, id }[]`（id 替代原 path） |
| GET | `/api/stories/:id` | — | `{ name, content }`（readStory） |
| GET | `/api/stories/:id/rag` | — | `{ name, content }`（readStoryForRag：服务端解析，含 OCR） |
| POST | `/api/stories/upload` | multipart `file` | `{ ok, name?, id?, error? }`（importStory） |
| DELETE | `/api/stories/:id` | — | `{ ok }` |

- 支持格式：PDF（pdf-parse + tesseract.js OCR）、TXT、MD、DOCX（mammoth）、EPUB（epub2）。
- 大文件：上传大小上限 50MB；解析在异步队列中执行（Task 4 简易内存队列），完成后可索引。

## 6. 剧本库脚本（Task 4，原 scripts 库）

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/scripts` | — | `{ name, id }[]` |
| GET | `/api/scripts/:id` | — | `{ name, content }` |
| PUT | `/api/scripts/:id` | `{ content }` | `{ ok }` |
| POST | `/api/scripts/upload` | multipart `file` | `{ ok, name?, id? }` |
| DELETE | `/api/scripts/:id` | — | `{ ok }` |

## 7. 存档（Task 5）

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/saves` | — | `string[]`（saveId 列表） |
| GET | `/api/saves/:id` | — | `GameSaveSnapshot`（原结构，见 `src/types/game.ts` + saveService） |
| PUT | `/api/saves/:id` | `GameSaveSnapshot` | `{ ok }` |
| DELETE | `/api/saves/:id` | — | `{ ok }` |

- `GameSaveSnapshot`：`{ version: 1, name, storyId, storyName, storyOverview, currentScene, cluesObtained, messages, kpMemory, longTermSummary, longTermFacts, playerTurnCount, gamePhase, characterSheet, playerName, selectedOccupationId, selectedOccupationName, sessionId, endingState?, scenesVisited? }`

## 8. RAG（Task 3，与 ragHandlers.cjs 一致）

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/rag/health` | — | `{ status, service }` |
| POST | `/api/rag/test-embedding` | — | `{ ok, vectorLength?, error? }` |
| POST | `/api/rag/test-graphrag-extract` | `{ scriptId, maxChunks?, maxBatches? }` | `{ ok, scriptId?, extractionModelUsed?, totalBatches?, testedBatches?, results?, error? }` |
| POST | `/api/rag/index` | `{ scriptId, chunks: {id,content,type,metadata}[], storyMeta? }` | `{ ok, indexed }` |
| DELETE | `/api/rag/index/:scriptId` | — | `{ ok, deleted }` |
| POST | `/api/rag/query` | `{ query, scriptId?, sceneId?, type?, topK? }` | `{ chunks: { content, metadata, distance }[] }` |
| POST | `/api/rag/context` | `{ query, scriptId?, sceneId?, topK? }` | `{ context, graphSummary?, chunkCount? }` |
| GET | `/api/rag/stories` | — | `{ storyId, name, chunkCount, indexedAt }[]` |
| POST | `/api/rag/story-overview` | `{ storyId, topK? }` | `{ overview, storyName }` |
| GET | `/api/rag/index/:scriptId` | — | `{ scriptId, storyName, chunkCount, chunks: {id,content,type,metadata,hasVector}[] }` |
| GET | `/api/rag/graph/:scriptId` | — | `{ scriptId, storyName, indexedAt, nodeCount, edgeCount, nodes, edges, communitySummaries } \| null` |
| POST | `/api/rag/user-graph/event` | `{ storyId, sessionId, event: {type,name,description?} }` | `{ ok }` |
| POST | `/api/rag/user-graph/sync` | `{ storyId, sessionId, state: {cluesObtained, currentScene} }` | `{ ok }` |
| POST | `/api/rag/user-graph/summary` | `{ storyId, sessionId }` | `{ summary }` |

- 数据按 `userId + storyId` 隔离。嵌入：`builtin`（@huggingface/transformers 本地模型，服务端加载）或 `api`（用用户 AI 设置中的 embedding 模型，同样受 outbound URL 校验约束）。

## 9. 客户端 Bridge 映射（Task 6）

`client/src/platform/bridge.ts` 的 `Bridge` 接口逐方法对应上述端点：

| Bridge 方法 | 后端调用 |
|---|---|
| getSettings / setSettings | GET/PUT `/api/settings` |
| listStories / readStory / readStoryForRag / importStory / deleteStory | `/api/stories*` |
| listScripts / readScript / saveScript / saveScriptToLibrary / deleteScript / importScript | `/api/scripts*` |
| aiChat / aiListModels | POST `/api/ai/chat`、GET `/api/ai/models` |
| kpInvoke | POST `/api/kp/invoke` |
| kpInvokeStream / onKpStream | WebSocket `kp:invoke` + 消息分发 |
| listSaves / readSave / writeSave | `/api/saves*` |
| ragHealth / ragIndex / ragDelete / ragQuery / ragContext / ragListStories / ragStoryOverview / ragGetIndex / ragGetGraph / ragUserGraphAdd / ragUserGraphSync / ragUserGraphSummary / ragTestEmbedding / ragTestGraphRagExtract | `/api/rag*` |
| login / register / logout / me（新增） | `/api/auth*` |
| platform | `'h5' \| 'mp-weixin' \| 'app'` |

## 10. 通用约定

- 文件大小限制：stories/scripts 上传 ≤50MB。
- JWT 过期返回 401，前端 bridge 统一跳转登录页。
- 所有服务端日志走 `server/src/utils/logging.ts`（迁移自 logging.cjs，traceId 上下文）。
- 路径安全：任何基于用户输入的路径拼接前必须过 `server/src/utils/pathSafety.ts`（迁移自 pathSafety.cjs）。
