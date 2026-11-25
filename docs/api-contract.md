# API 契约（以代码为准的导览）

> 定位：本文只做「面」级导览——模块分组 + 端点存在性 + 指向实现的阅读入口；各端点的
> 请求/响应形状、校验与语义以 `server/src/routes/*.ts` 及对应 service 实码为唯一权威，
> 本文与代码不一致时以代码为准（发现漂移请改文档或提票，勿照文档改代码）。
> 沿革：原 Electron `window.electronAPI`（见 `original/ai-trpg-web/src/env.d.ts`）的 IPC 面
> 由 REST + WebSocket 实现，本文节编号沿用至今（§6/§7/§8 等退役节保留注记不重排）。
> §10 安全约束是 D-09 红线文档：`pathSafety.ts` / `fileNames.ts` 等代码注释引用它，原文逐字节保留。
> 公开端点包括 `POST /api/auth/register`、`POST /api/auth/login` 及健康探针（§12）。`GET /api/auth/me` 及其余所有 `/api/*` 端点均需要 `Authorization: Bearer <JWT>`。
> 各部署模式的实挂路由组以 `server/src/app.ts` 为准，完整清单见 §11。

## 约定

- 所有请求/响应体均为 JSON（除文件上传 multipart 与文件下载）。
- 业务 API 的错误响应使用 `{ "error": string }` 与 4xx/5xx 状态码。
- 原 IPC 中的绝对文件路径参数一律替换为服务端生成的 `id`（安全要求，禁止暴露路径）。

---

## 1. Auth（新增，Task 2）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册，返回 token + 用户 |
| POST | `/api/auth/login` | 登录，返回 token + 用户 |
| GET | `/api/auth/me` | 当前用户 |

- JWT 鉴权（30 天有效期）；实现：`server/src/routes/auth.routes.ts` + `services/authService.ts` + `middleware/auth.ts`。
- 两种部署模式均提供这三个端点。共享模式下，通过任一网关签发的 token 可用于同一部署的其他网关。各模式只接受本模式签发的 token。共享模式的注册与登录在用户名含空字符时返回 400。

## 2. Settings（Task 2）— 替代 electron-store

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/settings` | 读当前用户设置（**不含 apiKey**） |
| PUT | `/api/settings` | 保存设置（apiKey 仅在变更时传） |

- 字段形状以 `shared/types/settings.ts` 为准（该文件注释声明镜像本节）；协议一等公民设计（protocol 取代 provider 两级模型）见 ADR-0003。
- 实现：`server/src/routes/settings.routes.ts` + `services/settingsService.ts`（apiKey 服务端 AES-256 加密存储，GET 不回传）。
- 两种部署模式均按登录账号读写设置。共享模式的 `PUT` 按字段合并 `ai` 与 `rag`，未提交的字段保留原值。同一账号的并发更新按事务顺序应用，同一字段以最后一次更新为准。本地模式用默认值填充未提交的非密钥字段。两种模式都在省略 `apiKey` 或提交空字符串、旧占位符 `***` 时保留已保存的密钥。

## 3. AI（Task 2）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/ai/chat` | 单发对话（MOCK_AI 短接入口之一） |
| GET | `/api/ai/models` | 按用途拉模型列表（`?purpose=chat\|embeddings`） |

- AI 配置（protocol/baseUrl/model/apiKey/temperature/maxTokens）**由服务端从用户设置读取**，请求体中不需要传。
- **安全约束**：服务端发起任何外部 URL 请求前必须校验 host —— 仅 http/https；拒绝 localhost、环回、私有（10/8、172.16/12、192.168/16、169.254/16）与保留地址（含 0.0.0.0、::、IPv6 映射）。实现于 `server/src/utils/outboundUrl.ts`。
- 模型列表/嵌入端点/流式等协议适配细节以 `server/src/routes/ai.routes.ts` + `services/aiService.ts` + `services/llm/` 实码为准（叙述见 ONBOARDING-GUIDE §八）。

## 4. KP Agent（Task 3）

- KP Agent 状态机（LangGraph）在服务端运行，配置读取与 AI 相同（服务端设置）。
- **ADR-0002**：REST `POST /api/kp/invoke` 与 WS `kp:` 前缀帧（`kp:turn`/`kp:invoke`）已删除；KP 回合唯一入口是房间协议（`room:action` → 服务端图内工具循环 → `room:event` 广播，见 `docs/history/ARCHITECTURE-MULTIPLAYER.md`）。
- 服务端 `invokeKp`/`invokeKpStream`（`kpAgentService.ts`）保留为测试 harness（零生产调用方），不在公网面。

### WebSocket（替代原 Electron `onKpStream` / `kp:stream`）

- 端点：`ws://<host>/ws?token=<JWT>`（H5/App）；小程序走 `wss://`；token 无效以 4001 关闭。
- 客户端发往服务端的单条 WebSocket 消息上限为 128 KiB，跨帧分片按整条消息计。超限时服务端以 1009 关闭连接。服务端因消息大小或发送缓冲超限断开连接时只清理订阅，房主可重连。
- 心跳：客户端每 30s 发 `{ "type": "ping" }`，服务端回 `{ "type": "pong" }`。
- 服务端 → 客户端推送：`{ "type": "rag:progress", "payload": {...} }`（RAG 索引进度，Task 4）。
- 当前房间帧（共享类型见 `shared/types/room.ts`）：
  - 客户端 → 服务端：`room:join {roomId}`、`room:leave {roomId}`、`room:sync {roomId,lastSeq}`、`room:action {roomId,action}`；聊天动作的形状为 `{type:"chat",payload:{content}}`。房主配置 AI 后仍可发送 `{type:"retry_kp"}` 继续已保存的回合。
  - 服务端 → 客户端：`room:state {roomId,snapshot,seq,actionReceipts:true}`（全量快照）、`room:event {roomId,seq,eventType,payload}`（增量事件）、`room:sync:done {roomId,seq}`、`room:error {roomId,error}`。增量事件类型由 `RoomEventType` 定义；`kp_chunk` 仅在实验开关开启时广播，客户端仍以完整 `message_appended` 为准。
  - `room:sync` 在事件仍处于保留窗口时补发增量并以 `room:sync:done` 收尾；缺口过大时改发全量 `room:state`。独立网关使用完整快照响应同步请求，实时事件仍按已提交的序列号投递。未知客户端消息类型忽略。架构沿革见 `docs/history/ARCHITECTURE-MULTIPLAYER.md`。

### 聊天行动回执

支持回执的房间在 `room:state` 中声明 `actionReceipts: true`。客户端为每次新聊天生成一个行动编号，并通过 `room:action {roomId,actionId,action}` 发送。编号允许 1–80 个 ASCII 字母、数字、下划线或短横线，按房间和登录账号隔离。消息内容必须是字符串，去除首尾空白后用于判定重试是否相同。相同编号和内容返回原消息编号及当前处理状态。同一编号改发其他内容返回 `action_conflict`。回执只发给提交请求的连接。

- `room:action:result {roomId,actionId,status,messageId}` 表示已持久化。等待室聊天立即为 `completed`。进行中的行动先为 `pending`，KP 回合结果入库后为 `completed`。行动执行前发现作者已离开，或房间在处理前结束，则为 `cancelled`，保留原聊天记录。当前成员可以重发原动作查询自己的回执。
- `room:action:result {roomId,actionId,status,code,error}` 表示本次请求未得到接收确认。`rejected` 是权限、内容或编号冲突。`busy` 表示房间达到待处理上限。命令入口饱和时可能先返回忙碌，稍后重发原编号即可查询已有回执。`retry` 表示暂时无法确认结果。忙碌、回执丢失和暂时性错误后均可用原编号重试。
- 旧客户端省略 `actionId` 时仍收到消息回显及原有错误帧，每次提交视作新的聊天。新客户端连接未声明回执能力的服务端时也使用旧协议。旧聊天、结构化骰子消息和 `retry_kp` 的帧格式保持兼容。
- 当前由单一房间进程执行。SQLite 和 PostgreSQL 均先提交聊天、回执和待处理状态，再广播回显。重启后，房间重新载入时恢复待处理行动。回合结果与已处理状态一并提交。提交前的中断可能使 KP 请求重做。后续跨进程所有权、事件转发和持久化回放见 ADR-0010。


## 5. 剧本 / 文件（Task 4）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/stories` | 剧本列表。提供 `limit`（1–100）或 `cursor` 时返回 `{stories, nextCursor}`，无参数时返回原数组。 |
| GET | `/api/stories/:id` | 读取剧本文本（`{ name, content }`）。共享目录支持 `?preview=1` 返回 `{ name, content, truncated }`。 |
| GET | `/api/stories/:id/source` | 共享剧本目录启用时，由网关流式返回原始文件附件。 |
| GET | `/api/stories/:id/rag` | 读取供 RAG 解析的原文（服务端解析，含 OCR） |
| POST | `/api/stories/upload` | 上传导入（multipart `file`） |
| DELETE | `/api/stories/:id` | 删除剧本 |

- 将返回的 `nextCursor` 用于下一页。上传的并发上限触发 HTTP 503 和 `Retry-After`。本地模式中，剧本准备超出并发上限也返回 503，同一剧本正在准备时删除或另启准备返回 409。运行参数见 [部署指南](DEPLOYMENT.md)。
- 支持格式、上传上限（见 §10）与解析细节见 `server/src/routes/stories.routes.ts`、`services/storyService.ts` 和 `rag/storyParsers.ts`。

仅启用共享剧本目录时，分页结果附加 `canPrepare: false`。故事管理页提供原文浏览、上传和删除。`GET /api/stories/:id/rag` 仅在本地模式挂载。共享目录的读取和下载需验证账号归属，跨账号请求返回 404，下载由网关传输，不返回对象存储 URL。共享目录删除后，列表和读取接口不再返回该条目。重复使用同一文件名上传会获得新 ID 并保留之前的原文修订。

共享预览最多返回 16,000 个 UTF-16 代码单元。纯文本预览从对象存储读取前 64 KiB；需要解析的文档超过 8 MiB 时返回 413，故事管理页提供文本预览，原始附件由通过身份验证的 `GET /api/stories/:id/source` 提供。每网关最多并发四次剧本文本读取，超限返回 503 和 `Retry-After`。

共享剧本准备启用时，分页目录返回 `canPrepare: true`、`preparationMode: 'durable'`，每个故事同时返回 `preparation`。状态形状为 `{activeRevision: string | null, job: {id, version, state, stage, percent} | null}`。任务状态为 `queued`、`running`、`complete` 或 `failed`。`version` 是十进制字符串，同一故事的已提交状态随版本数值递增。共享目录删除剧本只移除目录条目。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/stories/:id/preparation` | 提交准备。返回 202 和当前状态。该故事已有排队或运行任务时，返回该任务。 |
| GET | `/api/stories/:id/preparation` | 返回最新准备状态。仅故事所有者可查询。 |
| GET | `/api/rag/stories` | 共享准备启用时，按 §8 的分页契约列出已有完整可用版本的故事。分页返回 `canStartInvestigation: false` 时，首页提供准备状态入口。 |

## 6. 剧本库脚本（Task 4，原 scripts 库）（已退役，#97）

> `/api/scripts*` 全链已于 2026-09-13 退役（#91 C 桶「全链退役」拍板延伸，#94 + #97）：#94 先退 `GET /api/scripts`（列表）与 `POST /api/scripts/upload`（scriptService.listScripts / importScript / importLegacyFile 与 multer 接线）；#97 退剩余 `GET / PUT / DELETE /api/scripts/:id` 三端点——服务端路由 / scriptService / `scripts` 建表语句（fresh 安装不再建表，存量死表不迁移，同 #92 取舍）与路由自测一并删除。客户端 bridge 方法（readScript / saveScript / saveScriptToLibrary / deleteScript，#94 前的 listScripts / importScript 亦然）全零页面调用方、仅 bridge.test 自引用续命。剧本库语义由 §5 stories 面承载（e2e journey 的 `uploadScript` 帮助函数与剧本页上传实际走 `POST /api/stories/upload`）。本节编号保留不重排。

## 7. 存档（已退役，#92）

> `/api/saves*` 全链已于 2026-09-13 退役（#91 A 桶「全链退役」拍板）：服务端路由 / saveService / `saves` 建表语句（fresh 安装不再建表，存量死表不迁移，写入链断于 #59/#60）与 training save 导出源一并删除；客户端 bridge 方法已于 #60 删除。本节保留编号占位——§8+ 编号被 server/client/shared 多处注释引用，不重排（§9 bridge 映射行归后续票处理）。

## 8. RAG（Task 3，与 ragHandlers.cjs 一致）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/rag/health` | 服务健康检查 |
| POST | `/api/rag/test-embedding` | 嵌入连通性自测 |
| POST | `/api/rag/index` | 建/重建索引（只报 scriptId，服务端自读自切块，ADR-0007） |
| DELETE | `/api/rag/index/:scriptId` | 删除索引 |
| POST | `/api/rag/query` | 检索查询 |
| POST | `/api/rag/context` | 组装检索上下文（标准管线，无图扩展） |
| GET | `/api/rag/stories` | 已索引剧本列表。提供 `limit`（1–100）或 `cursor` 时返回 `{stories, nextCursor}`，按索引时间和故事 ID 降序翻页。无参数仍返回原数组。 |
| GET | `/api/rag/index/:scriptId` | 索引详情 |

> `/api/rag/story-overview` 已于 2026-09-13 退役（#91 B 桶「全链退役」拍板，#93）：服务端路由 / `ragService.storyOverview` / `vectorStore.getStoryOverview` 与路由自测段一并删除；客户端 bridge 方法已于 #85 删除。本节编号保留不重排（§8 被 server 路由注释引用）。

- 数据按 `userId + storyId` 隔离；嵌入双通道（本地模型 / 用户 AI 设置中的 API），无嵌入或单块嵌入失败时保留 TF-IDF 词面检索兜底；检索、切块细节以 `services/ragService.ts` + `rag/` 实码为准（叙述见 ONBOARDING-GUIDE §7）；API 出站同样受 §3 安全约束。

## 9. 客户端 Bridge 映射（Task 6）

客户端 Bridge 以 `client/src/platform/bridge.ts` 的 `PlatformBridge` 实现为准（页面经 `getBridge()` 取具体类；#80 退役了装饰化且已漂移的 `Bridge` 接口），逐方法对应上述端点；`shared/types/bridge.ts` 仅保留跨端共享的 wire payload 类型（`AuthResult`/`IndexedStory`/`RAG*Params`/`RagGetIndexResult` 等）：

| Bridge 方法 | 后端调用 |
|---|---|
| getSettings / setSettings | GET/PUT `/api/settings` |
| listStories / listStoryPage / readStory / importStory / deleteStory | `/api/stories*` |
| aiChat / aiListModels | POST `/api/ai/chat`、GET `/api/ai/models` |
| ragHealth / ragIndex / ragDelete / ragQuery / ragContext / ragListStories / ragListStoryPage / ragGetIndex / ragTestEmbedding | `/api/rag*` |
| roomCreate / roomList / roomCreateSolo / roomListSolo / roomJoin / roomDetail / roomStart / roomDelete | `/api/rooms*`（`roomListSolo` 由「游戏」调查 hub 用于 solo 续玩） |
| roomSetTurnWindow | PUT `/api/rooms/:id/settings` |
| roomBindCharacter / roomSetReady / roomLeave / roomKickMember / roomTransfer | `/api/rooms/:id/*` 房间治理端点 |
| characterCreate / characterList | POST/GET `/api/characters` |
| login / register / me | `/api/auth/register`、`/api/auth/login`、`/api/auth/me` |
| logout | 本地清除 token 并关闭 WS；服务端没有 logout REST 端点 |
| connectWs / sendRoomFrame / onRoomFrame / onReconnect | `/ws` 房间帧与客户端重连订阅，具体帧见 §4 |
| platform | `'h5' \| 'mp-weixin' \| 'app'` |

> KP 回合与存档读写不再有 bridge 直连方法：KP 回合走房间协议（ADR-0002）；存档/读档语义由房间快照与重新进入房间取代，`/api/saves*` 已按 §7 退役（#60 删除 listSaves/readSave/writeSave bridge 方法，#92 删除服务端链路）。原 scripts 桥接方法与 setImportFilePath 已于 #97 删除。故事管理页通过 readStory 调用 §5 的共享预览。readStoryForRag 的 bridge 包装已退役，本地端点由 e2e 直接调用。

## 10. 通用约定

- 文件大小限制：stories 上传 ≤50MB（scripts 上传面已随 #94 退役）。
- stories 上传默认上限为 52428800 字节（50 MiB），可由 `MAX_UPLOAD_BYTES` 覆盖。
- JWT 过期返回 401，前端 bridge 统一跳转登录页。
- 所有服务端日志走 `server/src/utils/logging.ts`（迁移自 logging.cjs，traceId 上下文）。
- 路径安全：任何基于用户输入的路径拼接前必须过 `server/src/utils/pathSafety.ts`（迁移自 pathSafety.cjs）。
- 路径边界补充：`assertPathInDir` 同时检查 lexical boundary 与 `realpath` boundary，符号链接指向允许目录外时拒绝。
- 文件落盘：外部 `storyId/scriptId` 不得进入文件名。上传文件使用 DB 中的内部 uuid `file_path`；RAG 使用 `RAG_DATA_DIR/<userId>/rag_index/<uuid>.json`，档案及其 `.gaps.json` / `.annex.json` sidecar 使用 UUID 文件名，并通过 JSON 元数据反查外部 id。旧版外部 id 文件名可读，重新索引/生成时迁移为 UUID。
- 生产配置：`NODE_ENV=production` 时 `JWT_SECRET` 必须设置为非空且非 `dev-secret-change-me` 的值，否则应用启动失败。

## 11. 实挂路由组一览（与 `server/src/app.ts` 对齐，9 组）

`local`（默认）挂载下表 9 组路由及 §4 的 WebSocket。`shared-accounts` 挂载第 1、2 组 HTTP 路由。配置私有对象存储后，同时挂载第 4 组共享目录路由（原文下载可用，RAG 解析路由留在本地模式）。设置 `ENABLE_SHARED_ROOMS=1` 的单个共享游戏进程还挂载第 7–9 组 HTTP 路由及 §4 的 WebSocket。该阶段使用独立的只读测试剧本目录。两种模式均提供 §12 的健康探针。启动配置与各阶段流程见 [部署指南](DEPLOYMENT.md)。

| # | 挂载路径 | 路由文件 | 端点（Path 级） | 导览 |
|---|---|---|---|---|
| 1 | `/api/auth` | `auth.routes.ts` | POST `/register`、POST `/login`、GET `/me` | §1 |
| 2 | `/api/settings` | `settings.routes.ts` | GET `/`、PUT `/` | §2 |
| 3 | `/api/ai` | `ai.routes.ts` | POST `/chat`、GET `/models` | §3 |
| 4 | `/api/stories` | `stories.routes.ts`（本地）、`sharedStories.routes.ts`（共享） | GET `/`、POST `/upload`、GET `/:id`、DELETE `/:id`；本地 GET `/:id/rag`，共享 GET `/:id/source` | §5 |
| 5 | `/api/rag` | `rag.routes.ts` | GET `/health`、POST `/test-embedding`、POST `/index`、DELETE `/index/:scriptId`、POST `/query`、POST `/context`、GET `/stories`、GET `/index/:scriptId` | §8 |
| 6 | `/api/dossier` | `dossier.routes.ts` | GET `/`、POST `/:scriptId/generate` | 档案 workflow（与 rag 并行）；叙述见 ONBOARDING-GUIDE §7 |
| 7 | `/api/rooms` | `rooms.routes.ts` | POST `/`、GET `/`、POST `/solo`、GET `/solo`、POST `/join`、GET `/:id`、POST `/:id/start`・`/:id/character`・`/:id/ready`・`/:id/leave`・`/:id/transfer`、DELETE `/:id`、DELETE `/:id/members/:userId` | 房间治理 REST（帧协议见 §4） |
| 8 | `/api/rooms` | `roomSettings.routes.ts` | PUT `/:id/settings` | 房间设置（turnWindowMs） |
| 9 | `/api/characters` | `characters.routes.ts` | GET `/`、POST `/` | 角色卡存取 |

- 房间解散只允许删除 `lobby` 或已结束房间；`playing` 房间返回 409，避免进行中的快照被 owner 直接删除。
- KP 回合不占路由组：唯一入口为房间协议（ADR-0002，帧协议细节见 §4）。
- §6/§7 为退役节：`/api/scripts*`、`/api/saves*` 已不在挂载面。

## 12. 健康探针

以下探针由 `server/src/app.ts` 提供，无需鉴权。

| Method | Path | 响应 |
|---|---|---|
| GET | `/health/live` | 200 `{ "status": "ok" }`，进程可响应 |
| GET | `/health/ready` | 数据库可访问时返回 200 `{ "status": "ready" }`，查询失败时返回 503 `{ "status": "unavailable" }` |
