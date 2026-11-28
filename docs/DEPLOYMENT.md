# 部署与上线指南（AI-COC-KP 多人版）

> 适用于 main 的默认本地部署与可选共享预发布。历史发布包请查阅对应版本标签的文档。
> 本文档覆盖：环境要求、构建、部署拓扑、环境变量、数据库迁移、上线检查清单、回滚。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 24**（node:sqlite 内置，零原生依赖） |
| 操作系统 | Linux（生产）/ Windows / macOS（开发均可） |
| 数据库与剧本存储 | 默认使用 `<DATA_DIR>/ai-kp.db` 和本地文件。共享预发布使用 PostgreSQL，启用共享目录或准备时还需私有 S3 兼容存储。 |
| 内存 | 单进程基线 ≥ 512 MB，原目标为 ≤100 个活跃房间。共享部署按网关、房间与剧本准备的实测峰值分别规划。 |
| 出网 | 需访问 LLM 提供商 API（OpenAI 兼容 / Anthropic / Google） |

## 2. 构建

```bash
npm ci
npm run build:h5          # 客户端 H5 产物 → client/dist/build/h5
cd server && npm run build  # 服务端 → server/dist
```

微信小程序：`npm run build:mp-weixin`（产物 `client/dist/build/mp-weixin`，用微信开发者工具上传）。

## 3. 默认本地部署拓扑

```
Nginx（TLS / WebSocket 升级）
  ├── /            → H5 静态产物（client/dist/build/h5）
  ├── /api/*       → Node 服务端（:3000）
  └── /ws          → Node 服务端 WebSocket（升级头）
```

- **单进程即可**：状态在内存（RoomService）+ SQLite 快照。≤100 并发房间无需 Redis。
- 多主机扩展方案见 [ADR-0010](adr/0010-scale-out-deployment.md)。当前运行形态采用单个游戏进程，可将索引和档案生成隔离到同机子进程。共享房间写入和跨进程事件投递需要 ADR-0010 的后续阶段。
- 探针：`GET /health/live` 返回进程存活状态。`GET /health/ready` 验证当前部署使用的数据库可访问。

## 4. 环境变量

> 路径说明：未显式设置时，目录相对于 `config.ts` 所在位置解析。开发模式下根目录是 `server/`；编译启动时根目录是 `server/dist/server/`。服务端构建会先删除再重建 `server/dist/`，所以生产环境必须为数据库、上传文件、RAG 与档案数据设置位于 `dist` 外的持久化绝对路径。各目录变量彼此独立；设置 `DATA_DIR` 不会自动移动其他目录。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | HTTP/WS 监听端口 |
| `DEPLOYMENT_MODE` | `local` | `local` 使用 SQLite。预发布环境可用 `shared-accounts` |
| `DATABASE_URL` | 未设 | `shared-accounts` 必设。两网关使用同一个 PostgreSQL 数据库连接地址 |
| `PG_POOL_MAX` | 10 | 每个进程的 PostgreSQL 连接上限，允许 1–100。启用共享房间时至少为 2，其中 1 个连接用于常驻部署锁 |
| `DATA_DIR` | 开发：`server/data`；编译：`server/dist/server/data` | SQLite 数据库目录（`ai-kp.db`）；生产请设置为 `dist` 外的持久化绝对路径 |
| `RAG_DATA_DIR` | 开发：`server/data/rag`；编译：`server/dist/server/data/rag` | RAG 索引文件；生产单独设置为持久化绝对路径，每用户子目录内使用 UUID 文件名 |
| `DOSSIER_DATA_DIR` | 开发：`server/data/dossiers`；编译：`server/dist/server/data/dossiers` | 档案及 `.gaps.json` / `.annex.json` sidecar；生产单独设置为持久化绝对路径 |
| `UPLOADS_DIR` | 开发：`server/uploads`；编译：`server/dist/server/uploads` | 用户上传的剧本文件；生产单独设置为持久化绝对路径，内部文件名使用 UUID |
| `MODELS_DIR` | 开发：`server/data/models`；编译：`server/dist/server/data/models` | 本地嵌入模型缓存；默认可重下载，需跨构建保留时单独设置持久化路径 |
| `TESSERACT_DATA_DIR` | 开发：`server/assets/tesseract`；编译：`server/dist/server/assets/tesseract` | OCR 语言数据目录；构建会将 checked-in assets 复制到编译目录 |
| `MAX_UPLOAD_BYTES` | 52428800（50 MiB） | stories 上传大小上限，单位为字节 |
| `STORY_UPLOAD_CONCURRENCY` | 4 | 每游戏进程同时接收 multipart 上传的上限 |
| `STORY_PREPARATION_WORKERS` | 0 | 设为 1 时，为每个已准入的索引或档案任务启动同机子进程 |
| `STORY_PREPARATION_CONCURRENCY` | 2 | 每进程同时处理的索引与档案任务总上限，超限返回 HTTP 503 与 `Retry-After` |
| `STORY_PREPARATION_TIMEOUT_MS` | 600000 | 隔离任务时限。超时后终止子进程，调用方可重试 |
| `ROOM_ACTIVE_INSTANCES` | 1024 | 每进程活跃实例的准入上限，请用实际负载确定部署值 |
| `KP_ACTIVE_TURNS` | 16 | 每进程并行执行的开场及玩家触发的 KP 主回合上限，同房间依序执行 |
| `JWT_SECRET` | 开发可用本地 fallback | **生产必设且不得使用 `dev-secret-change-me`**（JWT + AES 密钥派生源） |
| `MOCK_AI` | 未设 | `1` = 无 LLM 测试模式（**生产禁用**） |
| `ROOM_CONTEXT_BUDGET_CHARS` | 12000 | 每个房间注入 KP 的近期对话字符上限；长期摘要与结构化状态仍会单独注入 |
| `LLM_TIMEOUT_MS` | 60000 | 出站 LLM 请求超时（小于 5000 的值会回退到默认值） |
| `KP_WIRE_SAMPLING` | 开启 | 持久化真实 KP 回合的完整模型消息、工具调用与 RAG 注入文本到 `kp_wire_samples`；设置为 `0` 关闭。生产部署前应明确数据留存/隐私策略 |
| `KP_CHUNK_STREAM` | 关闭 | 实验开关。设置为 `1` 时可收到 `kp_chunk` 调试片段。启用房间 worker 故障接管时，每回合提交最多 8 个片段，内容合计最多 16 KiB。完整 `message_appended` 是权威消息，供客户端展示。 |
| `LOG_LEVEL` | `info` | 服务端日志级别 |

## 4.1 BYOK（玩家自带 API Key）使用引导

**服务端零 Key 架构**：本项目不持有、不配置任何 LLM API Key（`config.ts` 无 key 类环境变量；`server/.env.example` 也没有）。每个玩家的 Key 只存自己的服务端设置，且：

- **加密存储**：API Key 经 AES-256-GCM 加密落库（`settingsService`，派生自 `JWT_SECRET`）。
- **永不下发**：`GET /api/settings` 一律省略 `apiKey` 字段，客户端只能写入不能读回。
- **服务端代发**：AI 请求由服务端用**当前用户自己的 Key** 发出（`resolveAiConfig(userId)` → 四协议适配器）；多人房间的 KP 回合与 RAG 全程以**房主**的 Key/模型/剧本解析（成员无需配置）。

**玩家配置步骤**（任一端 H5 / 小程序均可）：

1. 打开 **设置 → AI 提供商**；
2. 选**接入协议**（OpenAI 兼容 Chat / Responses / Anthropic / Google）；多数中转站选 OpenAI 兼容；
3. **Base URL**：留空用协议默认值；自建/中转填完整地址（如 `https://api.openai.com/v1`）；
4. **API Key**：填自己的 Key（password 框，仅存服务端不回显）；
5. **模型**：点「刷新列表」实时拉取（带 Key 请求）或手动输入；
6. 点**保存设置** → 点**测试连接**（调真实模型返回一句确认）→ ✓ 连接正常。

**未配置时的表现**：

- 协议未选 → 「请先在设置中配置 AI 协议」；模型未填 → 「请先在设置中选择或输入模型名称」；
- Anthropic / Google 未填 Key → 「需要 API Key」；OpenAI 兼容本地端点（如 Ollama）可无 Key 运行；
- 上述错误会以 toast/消息形式出现在设置页与游戏页，指引回设置补全。

**离线试玩**：不配置任何 Key 也能完整跑通全部功能——`MOCK_AI=1` 启动后端进入确定性内置 AI（e2e 同款），适合本地体验/开发/CI（**生产禁用**）。

**真实 Key 验证**：`e2e/byok-smoke.mjs`（自备 Key 冒烟：settings 加密存储 → GET 不回传 → models 实时拉取 → chat 真实返回），用法见脚本头注释。

## 5. 数据库

- 启动时按序运行 `server/src/db/migrations.ts` 中的事务迁移，并在 SQLite `PRAGMA user_version` 记录 schema 版本（当前为 10）；fresh install 与无版本号的旧库都会自动升级。
- 所有待执行迁移在一个事务中提交。失败会回滚本次升级并在 HTTP 监听前中止启动，错误包含失败版本与修复/恢复建议；比当前服务更新的数据库版本会被拒绝，服务不会尝试降级。
- 备份：升级前停止服务，备份 `${DATA_DIR}/ai-kp.db`，以及配置的 `UPLOADS_DIR`、`RAG_DATA_DIR`、`DOSSIER_DATA_DIR` 目录；它们是独立路径，不保证位于 `DATA_DIR` 下。`MODELS_DIR` 是可重下载缓存，可按恢复时间目标选择是否备份。schema 迁移没有自动 down migration，回滚需恢复匹配版本的数据库备份。
- **无需手动迁移**：存量文件系统剧本首次 list 时自动导入 DB 映射（脚本导入已随 #97 / ADR-0008 scripts 退役摘除）。

## 6. 启动

```bash
# 生产（构建产物）
# 通过服务管理器/安全环境注入强随机 JWT_SECRET（不要把密钥写入 shell 历史）
cd server && NODE_ENV=production \
  DATA_DIR=/var/lib/ai-coc-kp/data \
  UPLOADS_DIR=/var/lib/ai-coc-kp/uploads \
  RAG_DATA_DIR=/var/lib/ai-coc-kp/rag \
  DOSSIER_DATA_DIR=/var/lib/ai-coc-kp/dossiers \
  node dist/server/src/app.js

# 开发
npm run dev:server   # :3000
npm run dev:h5       # :5175（vite dev）
```

示例中的目录应由服务账号持有或可写。若生产环境未设置 `JWT_SECRET`，或仍使用开发默认值 `dev-secret-change-me`，服务会在监听端口前退出，不会接受请求。

### 6.1 双网关账号预发布环境（#113）

为此环境准备独立的 PostgreSQL 数据库和登录角色。首次启动时，该角色需要在数据库默认的 schema 中建表。两网关使用同一构建产物，指向同一数据库及 schema。通过服务管理器或密钥管理系统向两进程注入相同的 `DATABASE_URL` 和强随机 `JWT_SECRET`，每套环境使用独立密钥。跨主机连接按数据库的 CA 配置 TLS，使用 `sslmode=verify-full` 验证主机与证书。

扩展实例前请为每个网关、房间 worker 和剧本准备进程显式设置 `PG_POOL_MAX`。所有实例的上限之和，加上监控、迁移及其他客户端所需连接，须低于部署角色可用的 `max_connections` 配额，并预留滚动升级和管理所需连接。共享房间常驻部署锁占用连接池中的 1 个连接，其余连接用于应用查询。

在两个终端从仓库根目录分别启动。两网关同机时使用不同的端口，跨主机时端口可相同。

```bash
NODE_ENV=production DEPLOYMENT_MODE=shared-accounts PORT=3000 npm run start --workspace=server
NODE_ENV=production DEPLOYMENT_MODE=shared-accounts PORT=3001 npm run start --workspace=server
```

两个进程会在 HTTP 监听前串行初始化并验证 PostgreSQL 表结构、约束与服务角色权限。`GET /health/ready` 检查该数据库。路由范围与设置行为见 [API 契约](api-contract.md#11-实挂路由组一览与-serversrcappts-对齐9-组)。共享账号与本地 SQLite 各自持有用户和设置，存量迁移留给后续阶段。两网关需保持同一 `JWT_SECRET`，它同时用于 JWT 验证和 BYOK 密钥派生。修改它会使旧 token 和原加密 API Key 失效。

验证时，通过一个网关注册，在另一网关登录，再交叉使用 token 调用 `/api/auth/me` 和读写设置。重启其中任一网关后复查。仓库另提供双网关 HTTP 测试，把 **独立、可销毁** 的 PostgreSQL 测试库连接地址注入 `TEST_SHARED_ACCOUNTS_DATABASE_URL` 后运行 `npm run test --workspace=server -- sharedAccounts.test.ts`。测试角色需能在该库新建临时 schema，测试会写入模拟用户与设置。CI 使用独立的 PostgreSQL 16 容器运行该套件。

### 6.2 双网关私有剧本目录（#114）

在第 6.1 节的两进程中额外注入相同的 `STORY_S3_BUCKET` 和 `STORY_S3_REGION`。自建 S3 兼容服务可设 `STORY_S3_ENDPOINT`（跨主机使用 HTTPS）及 `STORY_S3_FORCE_PATH_STYLE=true`。四个变量均未设置时仍使用第 6.1 节的账号配置。设置任一变量时，启动会检查必填配置。通过 AWS SDK 默认凭据链提供服务角色，可注入 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` 和可选的 `AWS_SESSION_TOKEN`。存储桶及网关凭据仅限该环境，关闭公开访问，服务角色只需对 `stories/*` 具有 `PutObject`、`GetObject`、`DeleteObject` 权限。两网关使用同一 PostgreSQL schema 和私有桶。

上传经网关的临时目录流式落盘，验证整个 multipart 请求后以已知长度流式写入私有对象。网关不在内存保留完整上传。临时盘应容纳每网关最多 `STORY_UPLOAD_CONCURRENCY`（默认 4）乘 `MAX_UPLOAD_BYTES`（默认 50 MiB）的在途数据，并为文件系统预留空间。异常退出遗留的 `aikp-story-upload-*` 目录可在网关停机后清理。读取及下载接口见 [API 契约](api-contract.md)。

只有写入对象成功并提交 PostgreSQL 事务后，目录才会公开该条目。每次上传拥有新的不可变原文修订。已确认失败会尝试清理该次上传的对象。若提交回执未知或客户端断线，请刷新目录确认后再上传。同一文件名可重复上传并得到不同 ID，上传接口不根据名称或内容去重。提交状态不明、进程崩溃或存储清理失败可能留下孤儿对象。清理孤儿时，应先暂停上传并核对 PostgreSQL 中所有活跃和已删除记录的修订，保留仍被引用的原文。删除先写入墓碑并保留原文修订，以支持后续房间固定修订。请勿按对象年龄批量过期。

共享目录页支持上传、翻页和选中预览。本地首页和多人等待室也按页列出已索引故事。两处通过 SQLite 索引查询目录元数据，首次读取或原子替换索引文件后会重新导入该账号的本地索引清单，包括旧版文件。只启用共享目录时可上传和浏览原文。剧本准备可按第 6.4 节单独启用。本地 SQLite 和本地文件部署行为不变。`/health/ready` 继续检查 PostgreSQL；应另外用合成文件验证私有对象存储的读写。仓库提供双网关测试，向 `TEST_SHARED_STORIES_DATABASE_URL` 注入独立、可销毁的 PostgreSQL 测试库，并向 `TEST_SHARED_STORIES_S3` 注入独立、可销毁私有桶的 JSON 配置（字段为 `bucket`、`region`、可选 `endpoint`、可选布尔值 `forcePathStyle`、包含 SDK 凭据字段的 `credentials`），随后运行 `npm run test --workspace=server -- sharedStories.test.ts`。测试会写入合成账号、文件和目录元数据，也会列举桶中该测试账号的对象验证清理。

### 6.3 单进程共享房间预发布（#115）

在 PostgreSQL 账号预发布配置上，为唯一的游戏进程另设 `ENABLE_SHARED_ROOMS=1` 和 `SHARED_ROOM_FIXTURE_DIR=<隔离的绝对路径>`。该进程提供既有房间、角色卡 REST 和 `/ws` 协议，并在启动时持有 PostgreSQL 会话锁。同库的其他账号网关可继续提供账号和设置，房间请求和 WebSocket 全部发往持锁的游戏进程。数据库负责保留账号、房间、成员、角色卡与房间快照。配置预发布账号自己的 BYOK 设置，或使用 `MOCK_AI=1` 进行无外部请求的演练。

由操作员把已准备的测试剧本复制到专用目录，按 PostgreSQL 账号 ID 归属。档案及其 sidecar 放在 `<dir>/dossiers/<account-id>/`，索引放在 `<dir>/rag/<account-id>/rag_index/`。文件使用服务端生成的 UUID 文件名与现有 JSON 格式。此处只读，房间开局仍检查对应 workflow 所需的产物。夹具模式限制原文查证和 wire 训练采样。启用共享原文和版本固定请参阅第 6.5 节。SQLite 的数据和产物目录必须与预发布夹具分开。

共享房间在发送玩家聊天回显前提交待处理行动。守秘人回合（含开场）的角色卡、场景、线索、结局、消息及消耗的行动一同提交，随后广播事件。进程在回合提交前终止时，重启从完整快照继续待处理行动。

使用独立的临时 PostgreSQL 数据库设置 `TEST_SHARED_ROOMS_DATABASE_URL`，在仓库根目录运行 `npm run test:server -- src/routes/sharedRooms.test.ts`。测试用同一套既有 REST 和 WebSocket 协议覆盖 SQLite 与 PostgreSQL 的建房、游戏进程重启、房主及剧本归属、角色卡与待处理回合。此配置用于单游戏进程预发布。分离网关与房间执行时使用下一节的角色设置。

#### 多房间进程故障恢复预发布（#120）

在共享房间配置上额外设置 `ENABLE_ROOM_WORKER_FAILOVER=1`。每个进程使用独立端口，共享 PostgreSQL、JWT 签名配置和准备好的剧本目录。`ROOM_WORKER_LEASE_MS` 默认 15000，允许 1000–120000 毫秒。PostgreSQL 使用数据库时钟判定租约。进程约每三分之一租期分批续租，每条续租查询最多处理 64 个房间，并将仍有效但被锁定的租约留到下次检查。加入房间时，新进程只有在租约可接管时才恢复房间。默认的 `ROOM_RUNTIME=direct` 适用于将 HTTP、WebSocket 和房间执行部署在同一进程的环境。

跨网关部署请使用以下进程角色。各进程使用相同的 PostgreSQL、JWT 签名配置和剧本存储配置。

- `ROOM_RUNTIME=gateway` 提供 HTTP 和 WebSocket，可以配置多个实例。负载均衡器将 HTTP 和 WebSocket 连接指向网关。
- `ROOM_RUNTIME=worker` 执行房间命令和 Keeper 回合，无需 HTTP 端口。每个房间由持有有效 PostgreSQL 租约的 worker 执行。切换到独立网关前，请先停止仍持有房间租约的 direct 实例。

开始接入前验证各网关的 `/health/ready` 并等待各房间 worker 输出 `Room worker ready`。网关探针只检查数据库连通性。再通过网关完成一次建房、订阅和行动回执，确认房间命令能由 worker 接收并返回结果。

跨网关使用已提交事件的序列号排序。加入和同步使用已授权的房间快照。房间命令的等待期限为 2.5 秒。交互命令按房间散列到 16 组，每组最多 32 条等待结果的命令。网关批量读取这些命令的结果。确认房主离线的持久通知使用独立的配额。暂时没有可用 worker 时，HTTP 房间命令返回 503，带行动编号的 WebSocket 聊天返回可重试结果。连接关闭后，已经开始执行的命令仍可能提交。重试聊天时请复用原有的 `actionId`，以便读取已有回执。

从使用全局房间命令配额的预发布构建升级时，请先在负载均衡器关闭新接入，并让旧网关排空连接后停止，然后启动采用分组配额的网关。两种构建使用不同的 PostgreSQL 接入锁，同时接入会突破配额。升级完成后再打开接入。已确认的行动保存在 PostgreSQL 中，客户端重连后可复用原有的 `actionId` 查询。

每次接管取得递增的房间 epoch。行动回执、回合结果、房间快照、按序房间事件和事件待投递记录在当前 epoch 校验下提交。进程在 Keeper 调用中退出后，下一进程从已持久化的行动批次继续。模型请求可能重复，已提交的角色卡、线索和结局效果只保存一次。已订阅的同进程连接在事务提交后接收事件。候选批次的成员或绑定角色在恢复时有变动，会记录原回合为已取消，再以新回合编号处理仍有资格的行动。未激活房间的 REST 写操作会临时获取租约，在同一 epoch 内完成权限检查和写入。

单进程模式使用排他启动锁，多进程预发布使用同一锁的共享模式。切换前先停掉正在运行的房间进程，再启动新模式。SQLite 无需配置。使用独立的 PostgreSQL 夹具运行 `npm run test:server -- src/routes/sharedRooms.test.ts`，覆盖抢占租约、延迟旧结果、杀进程恢复、按原批次重放和规则效果只提交一次。

共享模式仍处于受控预发布。扩大流量前需完成分布式的 30 分钟混合负载与独立的真实 BYOK 验证。direct 模式旧连接恢复及单回合大量事件的边界仍在跟踪。见 [验收方案](scale-out-staging.md)、[结果](scale-out-staging-results.md)、[#129](https://github.com/sunnyday9/COC-AI-KP-uni/issues/129) 和 [#130](https://github.com/sunnyday9/COC-AI-KP-uni/issues/130)。

### 6.4 共享剧本准备进程（#116）

先配置第 6.2 节的 PostgreSQL 和私有对象存储，并在所有网关及独立准备进程中设置 `STORY_PREPARATION_ENABLED=1`。网关负责接受请求并查询状态。每个准备进程同一时间处理一个任务，通过增加准备进程独立扩展 OCR、索引和档案生成。准备进程使用同一数据库、私有存储和 `JWT_SECRET`，由服务管理器注入设置并负责重启。

```bash
NODE_ENV=production DEPLOYMENT_MODE=shared-accounts STORY_PREPARATION_ENABLED=1 npm run start:story-preparation --workspace=server
```

任务租约默认 30 秒，可通过 `STORY_PREPARATION_LEASE_MS` 调整。租约到期后，其他准备进程可重新领取该任务。新进程重新读取原文并生成制品，可能再次调用模型。每次领取使用独立的对象修订。解析后的原文须在档案生成的 200,000 字符及批次数上限内，超限会显示为失败。

所有共享准备网关须使用相同的预算配置。旧准备进程停止后再升级共享网关和准备进程，以便让在途工作统一受新时限限制。每次新提交和显式重试都会保存总时限和领取上限。达到时限或自动领取上限后，所有者可从故事页显式重试。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `STORY_PREPARATION_PENDING_GLOBAL` | 128 | 全部账号的排队及运行任务总上限，范围 2 至 2048 |
| `STORY_PREPARATION_PENDING_PER_ACCOUNT` | 4 | 单个账号的排队及运行任务上限，须小于总上限。总上限小于 5 时，默认值随之降低 |
| `STORY_PREPARATION_DEADLINE_MS` | 1800000 | 从提交开始累计的毫秒数，包括排队等待，范围 1000 至 7200000 |
| `STORY_PREPARATION_MAX_ATTEMPTS` | 3 | 每个任务获得租约的次数上限，包括首次领取，范围 1 至 10 |

工作进程轮换处理已等待的账号，同账号内先处理较早入队的任务。达到单账号或共享队列上限时，网关返回 503 和 `Retry-After`。上传配额与房间回合配额分别管理。取消已排队或正在运行的任务会立即释放其队列配额，并使此前的领取凭据失效。已发出的模型调用可能在工作进程发现取消前结束。

仅当解析原文、索引、档案及匹配的原文锚点写入并通过对象核验后，共享目录才更新可用版本。新准备进程在首次写入前登记对象修订，发布事务同步移除该登记。准备进程分批清理失去有效租约且尚未发布的修订，只删除该次领取的四个预定对象键。已发布的修订会保留，包括供固定版本房间续玩的旧修订。

写入结果未确认时，清理会等待 150 秒（120 秒请求时限加 30 秒缓冲）。删除失败或清理进程中断后，准备进程可在 30 秒后重试。如果对象服务在缓冲期后仍完成写入，可能留下对象。滚动升级期间，旧进程仍可发布，自动清理只覆盖新进程登记的修订。人工清理历史遗留对象前，应暂停准备进程，并逐一核对 `story_preparation_revisions` 中的发布记录。

自动清理删除当前对象键。若对象桶启用了版本控制，旧版本字节仍由存储端保留。配置非当前版本的保留周期时，请同时遵循备份与恢复要求。

第 6.2 节的测试使用确定性 `MOCK_AI`，验证工作进程中断、双进程竞争领取，以及从真实存储读取完整修订。使用环回地址的 HTTP 路径式 S3 兼容服务时，测试还会在最后一个对象的核验阶段注入失败或终止工作进程，验证未发布对象得到清理，已发布版本仍可读取。

### 6.5 共享房间固定剧本版本（#118）

为共享游戏进程配置私有对象存储、`STORY_PREPARATION_ENABLED=1` 和 `ENABLE_SHARED_ROOMS=1`。分离运行时，所有网关和房间 worker 使用匹配的配置。单人和多人开局时会检查已发布的完整版本并保存剧本所有者、原文版本和准备版本。续玩、房主移交及再处理均沿用房间的固定版本。剧本目录删除采用软删除，已保存的房间仍可使用其版本。保留房间所引用的对象及数据库记录，冷加载遇到缺失或不一致的产物时会暂停回合。

共享游戏进程的分页索引清单返回 `canStartInvestigation: true`。未启用共享游戏的目录服务继续提供准备状态。未配置对象存储的受控预发布仍可按 6.3 使用隔离夹具。

### Keeper 容量与超时

每个进程独立限制 Keeper 开场和玩家回合。提供方按配置的 URL origin 分组，账号按房主分组。同一组达到并发上限时，调度器优先启动仍有容量的回合，再处理该组的队列。多进程部署的总容量是各进程容量之和。若需限制所有进程共用的上游配额，应在部署时为每个进程分配预算。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| KP_ACTIVE_TURNS / KP_PENDING_TURNS | 16 / 128 | 单进程内运行中和排队中的 Keeper 回合数 |
| KP_ACTIVE_PER_PROVIDER / KP_PENDING_PER_PROVIDER | 4 / 32 | 每个提供方 origin 的并发和排队上限 |
| KP_ACTIVE_PER_ACCOUNT / KP_PENDING_PER_ACCOUNT | 2 / 8 | 每个房主账号的并发和排队上限 |
| KP_QUEUE_TIMEOUT_MS | 30000 | 等待 Keeper 容量的最长时间 |
| KP_TURN_TIMEOUT_MS | 120000 | 获得容量后单回合的最长执行时间，包含知识装配和等待模型 |
| KP_PROVIDER_REQUEST_MS | 45000 | 单次 Keeper 模型请求的最长时间 |
| KP_PROVIDER_RETRIES | 2 | 每回合共用的 429 / 503 重试次数 |

当全局上限大于 1 时，单个提供方和账号各最多占用相应全局容量减 1。429 与 503 采用 250 毫秒起步、最高 4 秒的指数退避，并按照上游的 Retry-After 延后。正在执行的回合在退避不超过 10 秒且仍有重试预算时可以继续尝试。同一进程内使用同一房主账号和提供方 origin 的其他回合在退避期间暂停，保留已确认的行动，由房主在提示的时间后重试。每个退避记录最长保留 1 小时，最多跟踪 4096 组账号与 origin。达到上限时优先移除最早到期的记录。各进程独立跟踪退避。

对局中的原文查证、检索改写和远程嵌入沿用所在回合的容量与取消信号，单次最多等待 1 秒。回合后的记忆提取和长摘要只占用空闲容量，单次最多等待 5 秒。可选请求失败时使用已有的上下文与记忆，且不消耗正式回合的重试预算。剧本准备使用独立进程和容量设置。

使用独立保密的 KP_METRICS_TOKEN，通过 Authorization Bearer 请求 GET /health/keeper。独立运行的游戏服务在现有端口提供此路径。拆分部署时，为每个 ROOM_RUNTIME=worker 额外设置 KP_METRICS_PORT，从该进程所在主机或容器的 127.0.0.1 采集。同一主机上的每个 worker 使用不同端口。网关对此路径返回 404。响应的 runtime 标识 direct 或 worker，并报告本进程的运行数、排队数、退避数、各自上限、队列等待和模型请求耗时。提供方和账号各最多报告 32 组用量，使用 KP_METRICS_TOKEN 生成可跨采样关联的标签，更换 token 后标签会变化。指标不含房间、原始账号标识、提供方地址或密钥。

## 7. 上线检查清单

- [ ] `MOCK_AI` 未设置（或显式 `0`）
- [ ] `JWT_SECRET` 设为强随机值
- [ ] `DATA_DIR`、`UPLOADS_DIR`、`RAG_DATA_DIR`、`DOSSIER_DATA_DIR` 指向 `server/dist` 外的持久化绝对路径
- [ ] 已决定是否允许默认开启的 `KP_WIRE_SAMPLING` 保存完整模型上下文；未批准留存时设置 `KP_WIRE_SAMPLING=0`
- [ ] `npm run test:server` 全绿（用例数以当前 Vitest reporter/CI 输出为准）
- [ ] `npm run test:client` 全绿（用例数以当前 Vitest reporter/CI 输出为准）
- [ ] `npm run test:training:eval` 全绿（Node ≥24 的 node:test 自测）
- [ ] `node e2e/h5.journey.mjs` 全绿（真实浏览器；以当前 runner 输出为准）
- [ ] `node e2e/multiroom.journey.mjs` 全绿（双客户端房间链路；以当前 runner 输出为准）
- [ ] `node e2e/rooms.journey.mjs` 全绿（双浏览器多人房间 UI 链路；以当前 runner 输出为准）
- [ ] H5 构建 + 小程序构建成功
- [ ] 出网策略放行 LLM 提供商域名（SSRF 守卫会拒绝内网/保留地址）
- [ ] 反向代理配置 WebSocket 升级（`/ws`）

合成规模测试使用独立临时库和模拟 KP。运行 `node e2e/scale-smoke.mjs`，可用 `SCALE_ROOMS`、`SCALE_STORY_ROWS`、`SCALE_ROUNDS` 和 `SCALE_SPREAD_MS` 调整并发房数、剧本元数据行数、回合批次数和每批发送窗口。报告分别给出玩家消息回显、KP 回复和目录分页的 p95。生产验收应另查真实模型、长对话、活跃导入、重连和故障恢复。

拆分部署使用 [规模验收方案](scale-out-staging.md) 中的混合负载与故障测试。上线前在目标环境逐项验证验收预算。当前测量与待验证项目见 [预发布测试结果](scale-out-staging-results.md)。

## 8. 回滚

- 代码回滚：`git revert` 对应提交，重建 + 重启。
- 数据回滚：恢复第 5 节备份（DB + 配置的 uploads / rag / dossiers 目录）；只回滚代码、不回滚数据库不能撤销 schema 迁移。
- **兼容性**：DB 映射（D-09）向后兼容旧文件系统数据（自动导入）；旧版以外部 id 命名的 RAG/档案 artifact 仍可按 JSON 元数据读取，并在重新索引/生成时迁移为 UUID 文件名；SQLite schema 通过有版本的增量迁移升级。

## 9. 安全基线（v2.0 NFR-M4）

- JWT 认证（WS `?token=`，无效关 4001）
- API Key AES-256-GCM 加密存储（GET settings 不回传）
- SSRF 出站守卫（拒绝 localhost/私网/保留地址）
- 路径安全：外部 id 不参与 fs 路径；fs 使用内部 uuid 文件名，并执行 lexical + realpath 边界检查，拒绝符号链接逃逸（D-09）
- 房间权限：邀请码鉴权 + owner 校验 + 角色卡归属校验
- 骰子/规则服务端权威（防作弊）

## SQLite 迁移与回滚演练（#125）

参见 [SQLite 与私有对象存储迁移演练](MIGRATION-REHEARSAL.md)。
