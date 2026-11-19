# 部署与上线指南（AI-COC-KP 多人版）

> 版本：v0.2.0（2026-09-04 tag）· 分支：main
> 本文档覆盖：环境要求、构建、部署拓扑、环境变量、数据库迁移、上线检查清单、回滚。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 24**（node:sqlite 内置，零原生依赖） |
| 操作系统 | Linux（生产）/ Windows / macOS（开发均可） |
| 数据库 | SQLite（内置，无外部服务）——文件：`<DATA_DIR>/ai-kp.db` |
| 内存 | ≥ 512MB（单进程；≤100 并发房间） |
| 出网 | 需访问 LLM 提供商 API（OpenAI 兼容 / Anthropic / Google） |

## 2. 构建

```bash
npm ci
npm run build:h5          # 客户端 H5 产物 → client/dist/build/h5
cd server && npm run build  # 服务端 → server/dist
```

微信小程序：`npm run build:mp-weixin`（产物 `client/dist/build/mp-weixin`，用微信开发者工具上传）。

## 3. 部署拓扑（单进程，v2.0 NFR-M9）

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
| `KP_CHUNK_STREAM` | 关闭 | 实验开关；设置为 `1` 会广播 `kp_chunk` 增量事件，当前客户端不消费该帧，完整 `message_appended` 仍是权威消息 |
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

- 启动时按序运行 `server/src/db/migrations.ts` 中的事务迁移，并在 SQLite `PRAGMA user_version` 记录 schema 版本（当前为 9）；fresh install 与无版本号的旧库都会自动升级。
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

共享目录页支持上传、翻页和选中预览。本地首页和多人等待室也按页列出已索引故事。两处通过 SQLite 索引查询目录元数据，首次读取或原子替换索引文件后会重新导入该账号的本地索引清单，包括旧版文件。此阶段的目录提供原文，剧本准备、开局及房间固定原文和制品修订由后续阶段提供。本地 SQLite 和本地文件部署行为不变。`/health/ready` 继续检查 PostgreSQL；应另外用合成文件验证私有对象存储的读写。仓库提供双网关测试，向 `TEST_SHARED_STORIES_DATABASE_URL` 注入独立、可销毁的 PostgreSQL 测试库，并向 `TEST_SHARED_STORIES_S3` 注入独立、可销毁私有桶的 JSON 配置（字段为 `bucket`、`region`、可选 `endpoint`、可选布尔值 `forcePathStyle`、包含 SDK 凭据字段的 `credentials`），随后运行 `npm run test --workspace=server -- sharedStories.test.ts`。测试会写入合成账号、文件和目录元数据，也会列举桶中该测试账号的对象验证清理。

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
