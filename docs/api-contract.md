# API 契约（以代码为准的导览）

> 定位：本文只做「面」级导览——模块分组 + 端点存在性 + 指向实现的阅读入口；各端点的
> 请求/响应形状、校验与语义以 `server/src/routes/*.ts` 及对应 service 实码为唯一权威，
> 本文与代码不一致时以代码为准（发现漂移请改文档或提票，勿照文档改代码）。
> 沿革：原 Electron `window.electronAPI`（见 `original/ai-trpg-web/src/env.d.ts`）的 IPC 面
> 由 REST + WebSocket 实现，本文节编号沿用至今（§6/§7/§8 等退役节保留注记不重排）。
> §10 安全约束是 D-09 红线文档：`pathSafety.ts` / `fileNames.ts` 等代码注释引用它，原文逐字节保留。
> 所有 `/api/*` 端点（除 `/api/auth/*` 外）需要 `Authorization: Bearer <JWT>`；
> 实挂路由组以 `server/src/app.ts` 为准（9 组，完整清单见 §11）。

## 约定

- 所有请求/响应体均为 JSON（除文件上传 multipart 与文件下载）。
- 错误响应统一：`{ "error": string }` + 4xx/5xx 状态码。
- 原 IPC 中的绝对文件路径参数一律替换为服务端生成的 `id`（安全要求，禁止暴露路径）。

---

## 1. Auth（新增，Task 2）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册，返回 token + 用户 |
| POST | `/api/auth/login` | 登录，返回 token + 用户 |
| GET | `/api/auth/me` | 当前用户 |

- JWT 鉴权（30 天有效期）；实现：`server/src/routes/auth.routes.ts` + `services/authService.ts` + `middleware/auth.ts`。

## 2. Settings（Task 2）— 替代 electron-store

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/settings` | 读当前用户设置（**不含 apiKey**） |
| PUT | `/api/settings` | 保存设置（apiKey 仅在变更时传） |

- 字段形状以 `shared/types/settings.ts` 为准（该文件注释声明镜像本节）；协议一等公民设计（protocol 取代 provider 两级模型）见 ADR-0003。
- 实现：`server/src/routes/settings.routes.ts` + `services/settingsService.ts`（apiKey 服务端 AES-256 加密存储，GET 不回传）。

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
- 心跳：客户端每 30s 发 `{ "type": "ping" }`，服务端回 `{ "type": "pong" }`。
- 服务端 → 客户端推送：`{ "type": "rag:progress", "payload": {...} }`（RAG 索引进度，Task 4）。
- 房间帧（`room:join` / `room:leave` / `room:sync` / `room:action`）与 `room:event` 广播见 `docs/history/ARCHITECTURE-MULTIPLAYER.md`；未知消息类型忽略。

## 5. 剧本 / 文件（Task 4）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/stories` | 剧本列表（id 替代原 path） |
| GET | `/api/stories/:id` | 读取剧本 |
| GET | `/api/stories/:id/rag` | 读取供 RAG 解析的原文（服务端解析，含 OCR） |
| POST | `/api/stories/upload` | 上传导入（multipart `file`） |
| DELETE | `/api/stories/:id` | 删除剧本 |

- 支持格式、上传上限（见 §10）与异步解析队列等实现细节以 `server/src/routes/stories.routes.ts` + `services/storyService.ts` + `rag/storyParsers.ts` 实码为准。

> 桥接死包装 readStory / readStoryForRag 已于 2026-09-13 退役（#97）：客户端零页面调用方（仅 bridge.test 自引用）。端点现行保留——GET /api/stories/:id/rag 由 e2e dossier journey 直接消费；GET /api/stories/:id 现零非自测消费方（存疑待拍板，#97 票面留档）。

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
| GET | `/api/rag/stories` | 已索引剧本列表 |
| GET | `/api/rag/index/:scriptId` | 索引详情 |

> `/api/rag/story-overview` 已于 2026-09-13 退役（#91 B 桶「全链退役」拍板，#93）：服务端路由 / `ragService.storyOverview` / `vectorStore.getStoryOverview` 与路由自测段一并删除；客户端 bridge 方法已于 #85 删除。本节编号保留不重排（§8 被 server 路由注释引用）。

- 数据按 `userId + storyId` 隔离；嵌入双通道（本地模型 / 用户 AI 设置中的 API）与检索、切块细节以 `services/ragService.ts` + `rag/` 实码为准（叙述见 ONBOARDING-GUIDE §7）；API 出站同样受 §3 安全约束。

## 9. 客户端 Bridge 映射（Task 6）

客户端 Bridge 以 `client/src/platform/bridge.ts` 的 `PlatformBridge` 实现为准（页面经 `getBridge()` 取具体类；#80 退役了装饰化且已漂移的 `Bridge` 接口），逐方法对应上述端点；`shared/types/bridge.ts` 仅保留跨端共享的 wire payload 类型（`AuthResult`/`IndexedStory`/`RAG*Params`/`RagGetIndexResult` 等）：

| Bridge 方法 | 后端调用 |
|---|---|
| getSettings / setSettings | GET/PUT `/api/settings` |
| listStories / importStory / deleteStory | `/api/stories*` |
| aiChat / aiListModels | POST `/api/ai/chat`、GET `/api/ai/models` |
| ragHealth / ragIndex / ragDelete / ragQuery / ragContext / ragListStories / ragGetIndex / ragTestEmbedding | `/api/rag*` |
| login / register / logout / me（新增） | `/api/auth*` |
| platform | `'h5' \| 'mp-weixin' \| 'app'` |

> KP 回合与存档读写不再有 bridge 直连方法：KP 回合走房间协议（ADR-0002），存档走页面 → `/api/saves*`（§7，#60 删除 listSaves/readSave/writeSave bridge 方法）。scripts 与 story 读取的桥接死包装（readScript / saveScript / saveScriptToLibrary / deleteScript / readStory / readStoryForRag）与 setImportFilePath 已于 #97 删除（readStoryForRag 对应端点 §5 现行保留，e2e 直接消费）。

## 10. 通用约定

- 文件大小限制：stories 上传 ≤50MB（scripts 上传面已随 #94 退役）。
- JWT 过期返回 401，前端 bridge 统一跳转登录页。
- 所有服务端日志走 `server/src/utils/logging.ts`（迁移自 logging.cjs，traceId 上下文）。
- 路径安全：任何基于用户输入的路径拼接前必须过 `server/src/utils/pathSafety.ts`（迁移自 pathSafety.cjs）。

## 11. 实挂路由组一览（与 `server/src/app.ts` 对齐，9 组）

`createApp()` 实际挂载的 9 组路由如下；每组只给「端点存在性 + 代码入口」，请求/响应形状一律以对应 `routes/*.ts` 与 service 实码为准：

| # | 挂载路径 | 路由文件 | 端点（Path 级） | 导览 |
|---|---|---|---|---|
| 1 | `/api/auth` | `auth.routes.ts` | POST `/register`、POST `/login`、GET `/me` | §1 |
| 2 | `/api/settings` | `settings.routes.ts` | GET `/`、PUT `/` | §2 |
| 3 | `/api/ai` | `ai.routes.ts` | POST `/chat`、GET `/models` | §3 |
| 4 | `/api/stories` | `stories.routes.ts` | GET `/`、POST `/upload`、GET `/:id`、GET `/:id/rag`、DELETE `/:id` | §5 |
| 5 | `/api/rag` | `rag.routes.ts` | GET `/health`、POST `/test-embedding`、POST `/index`、DELETE `/index/:scriptId`、POST `/query`、POST `/context`、GET `/stories`、GET `/index/:scriptId` | §8 |
| 6 | `/api/dossier` | `dossier.routes.ts` | GET `/`、POST `/:scriptId/generate` | 档案 workflow（与 rag 并行）；叙述见 ONBOARDING-GUIDE §7 |
| 7 | `/api/rooms` | `rooms.routes.ts` | POST `/`、GET `/`、POST `/solo`、GET `/solo`、POST `/join`、GET `/:id`、POST `/:id/start`・`/:id/character`・`/:id/ready`・`/:id/leave`・`/:id/transfer`、DELETE `/:id`、DELETE `/:id/members/:userId` | 房间治理 REST（帧协议见 §4） |
| 8 | `/api/rooms` | `roomSettings.routes.ts` | PUT `/:id/settings` | 房间设置（turnWindowMs） |
| 9 | `/api/characters` | `characters.routes.ts` | GET `/`、POST `/` | 角色卡存取 |

- KP 回合不占路由组：唯一入口为房间协议（ADR-0002，帧协议细节见 §4）。
- §6/§7 为退役节：`/api/scripts*`、`/api/saves*` 已不在挂载面。
