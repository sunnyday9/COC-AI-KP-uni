# COC-AI-KP uni-app 多端重构计划

> 来源仓库：https://github.com/sunnyday9/COC-AI-KP
> 计划日期：2026-08-15
> 状态：待审批执行

---

## 一、现状与目标

### 当前架构
- **Vue 3 + Vite + Electron** 单机桌面应用（无服务器），渲染进程通过 `window.electronAPI`（约 40 个 IPC API）与 Electron 主进程通信
- **渲染层**：8 个 View、9 个组件、4 个 Pinia Store、13 个 Service、17 个 COC 工具（5 类 Handler）
- **主进程**：AI 对话（OpenAI SDK）、KP Agent（LangGraph 9 意图状态机，`kp:stream` 流式）、三层 RAG（TF-IDF + HuggingFace 本地嵌入 + GraphRAG + 用户行动图谱）、文档解析（pdf-parse + tesseract.js OCR + mammoth + epub2）、文件/存档/设置管理（electron-store）
- **安全**：API Key 仅存主进程，contextIsolation 开启，pathSafety 防路径穿越
- **已有伏笔**：settingsStore 中已存在 `syncServerUrl` 字段（默认 `http://localhost:3000`），说明项目已预留同步服务器架构

### 重构目标
- **后端**：Node.js/Express + TypeScript，承载原 Electron 主进程全部逻辑
- **前端**：uni-app（Vue 3）支持 **H5 + 微信小程序 + App（iOS/Android）** 三端
- **Electron 版本**：完全替换
- **RAG 复杂度**：尽可能完整保留（三层检索 + GraphRAG + OCR）

---

## 二、目标架构

```
┌─────────────────────────────────────────────────────┐
│                    uni-app 前端                      │
│  H5 / 微信小程序 / App(iOS/Android)                  │
│                                                      │
│  Pages(8) → Components(9) → Stores(4) → Services(13)  │
│                    ↓                                 │
│          Platform Bridge (抽象层)                     │
│     H5: fetch + WebSocket                           │
│     小程序: uni.request + uni.connectSocket           │
│     App: fetch + WebSocket                          │
└──────────────────────┬──────────────────────────────┘
                       │ REST API + WebSocket
┌──────────────────────┴──────────────────────────────┐
│              Node.js/Express 后端                     │
│                                                      │
│  Auth(JWT) → Routes → Services → RAG/AI/KP Agent    │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ AI 路由   │ │ KP Agent │ │ RAG 系统           │   │
│  │ OpenAI   │ │LangGraph │ │ TF-IDF+Embed+Graph│   │
│  │ SDK      │ │WebSocket │ │ pdf-parse/OCR      │   │
│  └──────────┘ └──────────┘ └────────────────────┘   │
│                                                      │
│  SQLite + Prisma (用户/设置/存档/RAG索引持久化)        │
└──────────────────────────────────────────────────────┘
```

---

## 三、目录结构

```
AI-COC-KP/
├── server/                              # Node.js 后端
│   ├── src/
│   │   ├── app.ts                       # Express 入口
│   │   ├── routes/
│   │   │   ├── auth.routes.ts            # 用户认证 (新增)
│   │   │   ├── ai.routes.ts              # ← electron/ipc/aiHandlers.cjs
│   │   │   ├── kp.routes.ts              # ← electron/ipc/kpAgentHandlers.cjs
│   │   │   ├── rag.routes.ts             # ← electron/ipc/ragHandlers.cjs
│   │   │   ├── file.routes.ts            # ← electron/ipc/fileHandlers.cjs
│   │   │   ├── save.routes.ts            # ← electron/ipc/saveHandlers.cjs
│   │   │   └── settings.routes.ts        # ← electron/ipc/settingsHandlers.cjs
│   │   ├── agent/kpGraph.ts              # ← electron/agent/kpGraph.mjs
│   │   ├── rag/                          # ← electron/rag/*
│   │   │   ├── embedding.ts, vectorStore.ts, graphRag.ts,
│   │   │   ├── graphStore.ts, userGraphStore.ts, storyParsers.ts
│   │   │   └── prompts/ (COC 定制抽取 Prompt)
│   │   ├── services/
│   │   │   ├── aiService.ts, kpAgentService.ts,
│   │   │   ├── saveService.ts, settingsService.ts,
│   │   │   ├── fileService.ts, sessionStore.ts (新增: KP会话状态),
│   │   │   └── authService.ts (新增: JWT)
│   │   ├── db/                           # Prisma schema + migrations
│   │   ├── utils/pathSafety.ts, logging.ts
│   │   └── ws/kpStream.ts                # WebSocket 流式推送
│   ├── package.json, tsconfig.json
│
├── client/                              # uni-app 前端
│   ├── src/
│   │   ├── pages/                        # ← src/views/ (8个页面)
│   │   │   ├── home/, scripts/, occupation/,
│   │   │   ├── character-create/, game/ (核心),
│   │   │   ├── game-end/, settings/,
│   │   │   └── rag-inspector/ (H5/dev only)
│   │   ├── components/                   # ← src/components/ (9个组件)
│   │   ├── stores/                       # ← src/stores/ (4个, electronAPI→bridge)
│   │   ├── services/                     # ← src/services/ (13个, electronAPI→bridge)
│   │   ├── platform/                     # 平台抽象层 (新增)
│   │   │   ├── bridge.ts (接口定义, 镜像electronAPI)
│   │   │   ├── httpAdapter.ts, wsAdapter.ts (H5/App)
│   │   │   ├── mpAdapter.ts, mpWsAdapter.ts (小程序)
│   │   │   └── index.ts (平台检测+适配器注入)
│   │   ├── logic/                        # ← src/logic/ (纯函数, 零改动)
│   │   ├── data/                         # ← src/data/ (静态数据, 零改动)
│   │   ├── toolCalling/                  # ← src/toolCalling/ (工具系统)
│   │   └── static/bg/                    # ← src/assets/bg/ (背景图, 需压缩)
│   ├── pages.json, manifest.json, uni.scss
│   ├── App.vue, main.ts, package.json
│
├── shared/                              # 前后端共享
│   ├── types/ (ai.ts, game.ts, character.ts, story.ts, ending.ts)
│   ├── constants/ (toolNames, presets)
│   └── tools/ (COC 工具定义, 替代 sync-tools.cjs)
│
├── docs/
└── package.json (workspace 根包)
```

---

## 四、分阶段实施计划

### Phase 0：项目脚手架搭建（1-2 天）
- **monorepo 初始化**：npm workspaces，server / client / shared 三包
- **server/ 初始化**：Express + TypeScript + Prisma + SQLite + ws(WebSocket)
- **client/ 初始化**：uni-app Vue 3 项目（`@dcloudio/vite-plugin-uni`，Vite 构建，非 HBuilderX）
- **shared/ 初始化**：共享类型与常量包
- **交付物**：三包可独立启动的空骨架

### Phase 1：后端 — AI 对话与用户认证（2-3 天）
- 迁移 `aiHandlers.cjs`（38KB）→ `/api/ai/chat`、`/api/ai/models` 路由
- 迁移 `settingsHandlers.cjs` → `/api/settings` 路由，electron-store 替换为 Prisma + SQLite
- 新增用户认证：`/api/auth/register`、`/api/auth/login`（JWT），API Key 加密存储（AES-256）
- 前端 settingsStore 改为登录后从后端拉取配置，localStorage 缓存
- **交付物**：前端可通过 HTTP 完成 AI 对话 + 设置持久化 + 用户登录

### Phase 2：后端 — KP Agent 与 WebSocket 流式（3-4 天）
- 迁移 `kpGraph.mjs`（33KB）→ 后端 LangGraph 状态机（9 意图分类 → 路由 → validate → forceTools）
- 迁移 `kpAgentHandlers.cjs` → `/api/kp/invoke` 路由
- WebSocket 服务器搭建：替代 `ipcRenderer.on('kp:stream')`，`ws://server/kp/stream`
- 新增 `sessionStore`：管理多用户多会话的 KP Agent 状态（内存 Map + TTL 30 分钟，后续可换 Redis）
- KP Agent 8 轮工具调用循环在服务端完成，通过 WebSocket 推送流式 chunk + toolCalls
- **交付物**：KP Agent 多轮工具调用工作流在服务端正常运行，前端接收流式输出

### Phase 3：后端 — RAG 系统完整迁移（3-4 天）
- 迁移 `embedding.mjs` → 后端嵌入服务（保留 `@huggingface/transformers` 本地模型 + OpenAI Embedding API 双模式）
- 迁移 `vectorStore.mjs` → 后端向量存储（文件持久化方案保留，或迁移至 SQLite）
- 迁移 `graphRag.mjs` + `graphStore.mjs` → GraphRAG 服务（实体/关系图谱 + 2-hop 扩展 + 社区摘要）
- 迁移 `userGraphStore.mjs` → 用户行动图谱（DB-backed，替代 electron-store）
- 迁移 `storyParsers.mjs` → 文档解析（pdf-parse + tesseract.js OCR + mammoth + epub2，traineddata 留服务端）
- 迁移 `ragHandlers.cjs` → `/api/rag/*` 路由（index/query/context/list/delete/health/usergraph）
- 向量索引与图谱持久化策略：按用户 ID + Story ID 隔离
- **交付物**：三层 RAG 检索在服务端完整运行

### Phase 4：后端 — 文件上传与存档服务（2 天）
- 迁移 `fileHandlers.cjs` → `/api/files/*` 路由（multer 接收 multipart 上传）
- 迁移 `saveHandlers.cjs` → `/api/saves/*` 路由（DB-backed，按用户隔离）
- 迁移 `pathSafety.cjs` → 路径安全检查（防穿越）
- 大 PDF 异步解析队列（BullMQ 或简易队列），WebSocket 推送索引进度
- **交付物**：剧本导入（上传→解析→分块→索引）、存档读写全部经后端 API

### Phase 5：平台抽象层 Bridge（2 天）
- 定义 `Bridge` 接口，签名镜像当前 `window.electronAPI` 全部约 40 个方法
- H5/App 适配器：`fetch`/`axios` + 原生 `WebSocket`
- 小程序适配器：`uni.request` + `uni.connectSocket`（含心跳保活 + 断线重连）
- 平台自动检测（`uni.getSystemInfoSync().uniPlatform`）+ 适配器单例注入
- 全局 `getBridge()` 替代 `window.electronAPI` 引用
- **交付物**：`getBridge().aiChat()` 在三端行为一致

### Phase 6：前端 — 路由与 Store 迁移（2-3 天）
- Vue Router → `pages.json` 配置（8 个页面，懒加载→分包加载）
- 路由守卫 `requiresGame` → 页面 `onLoad` 生命周期检查 `gamePhase`
- 4 个 Pinia Store 迁移：
  - `settingsStore`：`load()`/`save()` 改为 bridge HTTP 调用，登录后加载
  - `gameStore`（32KB，核心）：`sendPlayerMessage` 流程适配，`onKpStream` → WebSocket 监听
  - `storyStore`：剧本列表/导入/删除改 bridge
  - `debugStore`：KPTrace 数据源改 WebSocket 事件
- **交付物**：Store 逻辑与后端 API 对接

### Phase 7：前端 — 8 个页面迁移（4-5 天）
| Vue View | uni-app Page | 迁移要点 |
|---|---|---|
| HomeView | pages/home | HTML→uni组件，背景图懒加载 |
| ScriptListView | pages/scripts | 文件选择改 `uni.chooseFile`/`uni.chooseMessageFile`，上传进度条 |
| OccupationSelectView | pages/occupation | 列表滚动改 `scroll-view` |
| CharacterCreateView | pages/character-create | 表单组件，骰子动画适配 |
| **GameRoomView** | **pages/game** | **核心**：流式消息 WebSocket、工具调用 UI、状态栏、线索面板；拆分子组件 |
| GameEndView | pages/game-end | 结局总结展示 |
| SettingsView | pages/settings | 新增登录/注册表单；AI/RAG 配置表单 |
| RagInspectorView | pages/rag-inspector | 条件编译 `#ifdef H5`，小程序排除 |

- HTML 标签统一转换：`div→view`、`span/p→text`、`img→image`、`ul→scroll-view`
- **交付物**：全部页面可渲染，基础交互可用

### Phase 8：前端 — 组件迁移与样式适配（3 天）
- 9 个组件迁移，uni-app 组件化改造
- **Tailwind CSS → UnoCSS**（`@uni-helper/unocss-preset-uni`）保留 utility-first 体验，rpx 单位自适应
- 小程序不支持 `*` 通配符、部分伪类 → UnoCSS 预设已处理
- 条件编译处理平台差异（`#ifdef MP-WEIXIN` / `#ifdef H5` / `#ifdef APP-PLUS`）
- 小程序分包配置：主包（首页+脚本+设置）<2MB，游戏分包（GameRoom+组件），角色创建分包
- 背景图压缩：当前 5 张约 4MB → WebP 格式压缩至 <500KB/张，懒加载
- **交付物**：三端 UI 一致，样式适配完成

### Phase 9：工具调用系统对接（2 天）
- `toolCalling/handlers/*`（5 类 17 工具）：纯逻辑无 Electron 依赖，直接复用
- `orchestrator.ts`：`processToolCalls` 适配，工具执行结果通过 bridge 返回前端
- 工具定义统一：`shared/tools/cocTools.ts` 替代 `sync-tools.cjs` + `cocToolNames.json`，构建时分发
- `toolContextFactory.ts`：依赖注入调整（角色卡数据来源改 bridge）
- **交付物**：工具调用流程在前后端分离架构下完整运行

### Phase 10：测试与三端验证（3-4 天）
- **后端**：API 集成测试（supertest），覆盖 auth/ai/kp/rag/save 全路由
- **直接复用**：`logic/` 纯函数测试 + `toolCalling/handlers` 测试（137 用例，零改动）
- **前端**：Store 集成测试（mock bridge），关键页面渲染测试
- **H5**：Playwright E2E，覆盖完整跑团旅程（登录→选剧本→创角色→游戏→结局→存档）
- **微信小程序**：微信开发者真机测试
- **App**：HBuilderX 真机打包测试（iOS/Android）
- **交付物**：三端可用，核心流程闭环

---

## 五、关键技术难点与方案

| 难点 | 方案 |
|---|---|
| **流式输出** | H5/App：原生 WebSocket；小程序：`uni.connectSocket`；后端 ws 库替代 IPC `kp:stream` |
| **API Key 安全** | 当前后端加密存储（AES-256）+ JWT 认证；前端不再持有 Key |
| **RAG 持久化** | 向量索引/图谱按 用户ID+StoryID 隔离，文件或 SQLite 持久化 |
| **小程序包体积** | 主包 <2MB，游戏页/角色页独立分包；RagInspector 仅 H5；背景图 WebP 压缩 |
| **大文件上传** | 小程序 10MB 限制：分片上传 or 仅 H5/App 支持大剧本；后端异步解析队列 |
| **Tailwind→uni-app** | UnoCSS + uni-preset，保留 utility-first，rpx 自适应 |
| **LangGraph 有状态** | WebSocket 连接保持会话上下文；后端 sessionStore（内存/Redis）+ TTL |
| **OCR 与文档解析** | tesseract.js + pdf-parse/mammoth/epub2 全部留服务端，traineddata 服务端加载 |

---

## 六、可零改动直接复用的模块

以下模块无 Electron 依赖，迁移时直接复制：
- `src/logic/*`：COC 规则纯函数（coc7Character、coc7Rules、environmentRules、growthRules、healingRules）
- `src/data/coc7.ts`：静态规则数据
- `src/services/diceService.ts`：骰子服务
- `src/toolCalling/handlers/*`：5 类工具 Handler（纯逻辑）
- `src/toolCalling/types.ts`、`cocToolNames.json`：类型定义
- `src/services/tracing/*`：KPTrace 可观测性（traceBus 事件驱动，无 IPC 依赖）
- 全部 `__tests__/` 纯函数测试（137 用例）

---

## 七、计划反思与风险分析

**R1 — 后端有状态 vs 无状态**
LangGraph KP Agent 是有状态的（多轮工具调用，最多 8 次迭代），无法用纯 REST 无状态实现。方案：WebSocket 连接保持会话 + 后端 sessionStore（内存 Map + TTL 30 分钟）。风险：断线重连需恢复会话上下文，需在 sessionStore 中持久化中间状态。

**R2 — 多用户并发与本地嵌入模型瓶颈**
`@huggingface/transformers` 本地推理在单机多用户并发下可能成为性能瓶颈。方案：模型预热 + 推理队列；或默认推荐用户切换为 `provider: 'api'`（OpenAI Embedding API）。风险：'builtin' 模式在多用户后端不够现实，SettingsView 中应引导用户选择 API 模式。

**R3 — 小程序 WebSocket 限制**
微信小程序同时连接数限制（5 个）、后台 30 秒断连。方案：单一 WebSocket 连接复用（频道机制区分 KP 流/RAG 进度/通用消息），心跳保活 + 自动重连。风险：长时间跑团（>30 秒无操作）可能断连，需前端自动重连 + 后端 sessionStore TTL 配合恢复。

**R4 — gameStore.ts 32KB 迁移复杂度**
这是核心文件，包含 `sendPlayerMessage` 完整流程，依赖 5 个 Service。迁移时所有 `window.electronAPI` 调用需替换为 bridge 调用，流式监听改 WebSocket。风险：逻辑回归，需详尽集成测试覆盖。建议 Phase 6 优先迁移 gameStore 并跑通核心链路。

**R5 — 小程序大 PDF 剧本支持**
仓库中的剧本 PDF 最大 36MB，小程序上传限制 10MB。方案：小程序端限制剧本大小 10MB 或引导用户在 H5/App 端导入大剧本后同步。风险：小程序用户无法导入大剧本，需 UI 明确提示。

**R6 — 渐进式迁移 vs 全量重写**
纯函数层（logic、dice、toolCalling handlers）可直接复用，降低工作量。服务层和视图层需逐个重写。建议：先跑通核心链路（登录→设置→AI 对话→KP Agent 流式→存档），再逐步迁移外围页面。风险：全量重写周期约 25-33 天，需分阶段验收。

**R7 — sync-tools 机制演变**
当前 `sync-tools.cjs` 生成 `cocToolNames.json` 供三端同步。新架构应将工具定义移至 `shared/tools/` 包，server 和 client 共同引用，消除手动同步。风险：迁移期间工具名不一致导致 AI 调用工具名与 handler 不匹配。

**R8 — Tailwind → UnoCSS 像素适配**
当前 Tailwind 用 px/rem，uni-app 小程序用 rpx（750rpx = 屏幕宽度）。UnoCSS 可配置 rpx 转换但需统一 750px 设计稿基准。风险：三端像素表现不一致，需逐一调试关键页面布局（尤其 GameRoomView 的聊天列表 + 状态栏布局）。

---

## 八、实施时间线总览

| 阶段 | 内容 | 预估工期 | 依赖 |
|---|---|---|---|
| Phase 0 | 脚手架搭建 | 1-2 天 | — |
| Phase 1 | AI 对话 + 认证 | 2-3 天 | P0 |
| Phase 2 | KP Agent + WebSocket | 3-4 天 | P1 |
| Phase 3 | RAG 完整迁移 | 3-4 天 | P1 |
| Phase 4 | 文件 + 存档 | 2 天 | P1 |
| Phase 5 | Bridge 抽象层 | 2 天 | P0 |
| Phase 6 | 路由 + Store 迁移 | 2-3 天 | P5 |
| Phase 7 | 8 页面迁移 | 4-5 天 | P6 |
| Phase 8 | 组件 + 样式适配 | 3 天 | P7 |
| Phase 9 | 工具调用对接 | 2 天 | P2,P6 |
| Phase 10 | 测试 + 三端验证 | 3-4 天 | P9 |
| **合计** | | **约 25-33 天** | |

Phase 1-4（后端）与 Phase 5-6（Bridge+Store）可部分并行，缩短关键路径。

---

## 九、技术选型确认

| 层面 | 选型 | 理由 |
|---|---|---|
| 后端框架 | Express + TypeScript | 现有主进程代码是 CJS/MJS，Express 迁移成本最低 |
| 数据库 | SQLite + Prisma | 轻量，无需独立 DB 服务器，后续可迁移 PostgreSQL |
| WebSocket | ws | 轻量，直接替代 IPC 流式 |
| 认证 | JWT + bcrypt | 标准方案，无状态验证 |
| 任务队列 | BullMQ（可选） | 大 PDF 异步解析，初期可用简易内存队列 |
| uni-app 构建 | @dcloudio/vite-plugin-uni | Vite 生态，支持 monorepo，无需 HBuilderX IDE |
| 样式 | UnoCSS + @uni-helper/unocss-preset-uni | 保留 Tailwind utility-first 体验，兼容小程序 rpx |
| 状态管理 | Pinia | uni-app 原生支持 Pinia，Store 代码可最大限度复用 |
