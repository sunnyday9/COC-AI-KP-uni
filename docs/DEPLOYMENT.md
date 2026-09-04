# 部署与上线指南（AI-COC-KP 多人版）

> 版本：v0.2.0（2026-08-20）· 分支：feature/multiplayer-rooms
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
- 多实例触发条件（超出后引入）：活跃房间 > 100 → Redis 会话锁 + 事件总线。

## 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | HTTP/WS 监听端口 |
| `DATA_DIR` | `server/data` | SQLite 与运行数据目录 |
| `RAG_DATA_DIR` | `<DATA_DIR>/rag` | RAG 索引/图谱文件 |
| `UPLOADS_DIR` | `<DATA_DIR>/uploads` | 剧本/脚本文件（内部 uuid 文件名） |
| `MODELS_DIR` | `<DATA_DIR>/models` | 本地嵌入模型缓存 |
| `JWT_SECRET` | 随机 | **生产必设**（AES 密钥派生源） |
| `MOCK_AI` | 未设 | `1` = 无 LLM 测试模式（**生产禁用**） |
| `LLM_REQUEST_TIMEOUT_MS` | 60000 | 出站 LLM 超时 |

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

- 首次启动自动建表 + 幂等迁移（`stories.file_path` / `scripts.file_path` 列自动 ALTER）。
- 备份：停止服务后复制 `<DATA_DIR>/ai-kp.db` + `uploads/` + `rag/` 目录。
- **无需手动迁移**：存量文件系统剧本/脚本首次 list 时自动导入 DB 映射。

## 6. 启动

```bash
# 生产（构建产物）
cd server && NODE_ENV=production JWT_SECRET=<强随机> node dist/server/src/app.js

# 开发
npm run dev:server   # :3000
npm run dev:h5       # :5175（vite dev）
```

## 7. 上线检查清单

- [ ] `MOCK_AI` 未设置（或显式 `0`）
- [ ] `JWT_SECRET` 设为强随机值
- [ ] `npm run test:server` 全绿（365）
- [ ] `npm run test:client` 全绿（97）
- [ ] `node e2e/h5.journey.mjs` 14/14（真实浏览器）
- [ ] `node e2e/multiroom.journey.mjs` 9/9（双客户端房间链路）
- [ ] `node e2e/rooms.journey.mjs` 8/8（双浏览器多人房间 UI 链路）
- [ ] H5 构建 + 小程序构建成功
- [ ] 出网策略放行 LLM 提供商域名（SSRF 守卫会拒绝内网/保留地址）
- [ ] 反向代理配置 WebSocket 升级（`/ws`）

## 8. 回滚

- 代码回滚：`git revert` 对应提交，重建 + 重启。
- 数据回滚：恢复第 5 节备份（DB + uploads + rag 三件套）。
- **兼容性**：DB 映射（D-09）向后兼容旧文件系统数据（自动导入）；房间表为增量（`CREATE TABLE IF NOT EXISTS`），旧版本代码可安全运行于新库。

## 9. 安全基线（v2.0 NFR-M4）

- JWT 认证（WS `?token=`，无效关 4001）
- API Key AES-256-GCM 加密存储（GET settings 不回传）
- SSRF 出站守卫（拒绝 localhost/私网/保留地址）
- 路径安全：外部 id 只进 DB 查询，fs 只用内部 uuid 文件名（D-09）
- 房间权限：邀请码鉴权 + owner 校验 + 角色卡归属校验
- 骰子/规则服务端权威（防作弊）
