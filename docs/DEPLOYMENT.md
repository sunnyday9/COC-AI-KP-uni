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
