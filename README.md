# COC AI KP — 克苏鲁的呼唤 · AI 守密人

> **单人 + 多人联机的 AI 跑团（TRPG）平台**：导入你的剧本 → AI 守密人（Keeper）驱动克苏鲁 7th 规则跑团——探索、战斗、SAN 检定、线索门控、结局结算。全栈 TypeScript monorepo，H5 / 微信小程序 / App 三端。

COC 7th 规则 AI 跑团助手，由原 Electron 单机应用重构而来。服务端（Express + TypeScript）承载 AI 守密人 Agent 的全部规则与记忆：LangGraph 状态机、RAG 剧本检索、SQLite 持久化、WebSocket 实时帧。前端 uni-app（Vue 3 + Pinia），暗色克苏鲁哥特 UI（ADRs 驱动的完整设计令牌体系）。

> 核心玩法闭环：**导入剧本 → RAG 索引 → 创建角色 → 与 AI 守密人对话 → 工具链驱动探索 / 战斗 / SAN 检定 → 线索门控推进剧情 → 结局结算 → 存档 / 读档**。

## 功能总览

### 🕯️ 单人调查（ADR-0002）
- 导入剧本（txt / md / json / pdf OCR / docx / epub / html）→ 结构化 RAG 索引 → 首页故事卡启动；
- 单页三步建卡向导：**选职业 → 投掷属性 + 职业技能 / 兴趣技能 → 姓名 + 档案预览**（COC 7th 全职业表，含 1920s / 现代双时代）；
- 与 AI 守密人实时对话（WS 帧协议）：**18 个 COC 工具**（`skill_check / san_check / roll_dice / adjust_hp / first_aid / spend_luck / transition_scene / grant_clue / end_game / trigger_insanity / melee_attack / ranged_attack` …）驱动检定与叙事；
- **确定性规则兜底**：SAN 损失超阈值强制疯狂、结局表达强制结算、停滞轮次强制推进——不依赖 LLM 自觉；
- 羊皮纸角色卡三处复用（建卡预览 / 游戏右栏 / 结局最终态）；进度服务端快照，随时续玩。

### 👥 多人联机（ADR-0005）
- **等待室（lobby）**：房主选已索引剧本、房间码邀请、成员各自绑定角色卡、全员就绪、开局门闩（未绑卡 / 未选剧本 → 开局被拒）；
- **房间治理**：踢出 / 主动转让 / 房主断线立即转让 / 解散，成员被移出有明确提示回大厅；
- 开局后进入**同一张游戏桌**：桌面三栏（左场景线索 / 中对话流 / 右调查员档案），移动端单栏 + bottom sheet；
- **队友档案切换**：随时查看任一成员的调查员档案（含未绑卡空态）；
- KP 回合全程以**房主**的模型 / Key / 剧本解析——房主开房，房主驱动（成员无需任何 AI 配置）。

### ⚙️ AI 接入：BYOK（Bring Your Own Key）
- **服务端零 Key 架构**：不持有、不配置任何 LLM Key；每个玩家在设置页填自己的 Key，**AES-256-GCM 加密落库、GET 永不回传**，AI 请求由服务端用玩家自己的 Key 代发；
- 四协议一等公民（ADR-0003）：OpenAI Chat / OpenAI Responses / Anthropic Messages / Google（Gemini），自定义 Base URL 支持中转站；
- **`MOCK_AI=1` 离线试玩**：零配置跑通全部功能（确定性内置 AI，LangGraph 状态机照跑），也是 E2E 的测试底座；
- 设置页内置「测试连接」实时校验；多人局多人各自配 Key 互不干扰（房主出 Key）。

### 🎨 UI / UX（ADR-0004）
- 暗色克苏鲁哥特设计系统（gothic-eldritch）：墨黑 / 羊皮纸 / 克苏鲁绿 / 血 / 理智紫 / 仪式金 / 魔力蓝完整令牌色板；
- 桌面 1440 + 移动 390 双断点适配；沉浸层大背景（home / game / game-end）分层；
- 消息类型体系：KP 羊皮纸卡 / 玩家气泡 / 系统叙事 / 骰子大焦点卡 / 线索金 pill / 伤害血红（流式光标、可选行动按钮）；
- 危险操作分级确认弹窗、空态引导、操作 toast——全站一致。

## 技术架构

```
client (uni-app: H5 / mp-weixin / App)
  ├─ 页面层      Vue 3 + Pinia（房间帧协议 RoomClient 视图）
  ├─ 设计令牌    App.vue :root → 全站 var(--) + scoped 引用
  └─ shared/     纯 TS 源码包（类型、COC 工具定义、provider 清单）

server (Express + TypeScript)
  ├─ KP Agent    LangGraph 状态机（analyzeInput → routeByIntent → PlanTools
  │              → Generate → Validate → forceTools）
  ├─ RAG         TF-IDF + 稠密向量 + GraphRAG（实体图谱 2 跳扩展）
  ├─ 房间        状态机 + 快照（solo = 单成员房间；multi = 治理状态机）
  ├─ SQLite      node:sqlite（WAL），零原生依赖
  └─ WS          帧协议：消息 / 骰子 / 工具 / 档案 / 回合（全序 seq + 增量同步）
```

- **规则与记忆全在服务端**（ADR-0002）：客户端无规则、无工具循环、无提示词组装——房间事件流是唯一事实源，重进 / 刷新即恢复；
- **多端一码**：同一套 Vue 代码跑 H5 / 微信小程序 / App，条件编译处理平台差异；
- 架构决策全程 ADR 记录（`docs/adr/0001–0005`），术语统一见 `CONTEXT.md`。

## 目录结构

```
AI-COC-KP/
├── server/        # Express + TS 后端（JWT、SQLite、LangGraph KP、RAG、WS 帧协议）
├── client/        # uni-app 前端（H5 / 微信小程序 / App）
├── shared/        # 共享 TS 源码包（COC 规则定义、类型、provider 清单）
├── e2e/           # 端到端旅程（h5 单人 14 步 / rooms 多人 UI 14 步 / multiroom WS 14 步，MOCK_AI）
├── test-agent/    # Agent 工作流真实 LLM 测试套件（不改项目代码）
├── tools/         # 微信小程序自动化测试（miniprogram-automator）
├── docs/          # ADR、架构、部署、API 契约、依赖审计报告
└── original/      # 原 Electron 项目（只读参考）
```

## 快速开始

环境要求：**Node.js ≥ 24**（内置 `node:sqlite`）、H5 E2E 需本机 Edge/Chrome。

```bash
npm install          # monorepo workspaces（client 为 uni-app，体积较大属正常）
```

**零配置试玩（推荐先跑这个）**：

```bash
MOCK_AI=1 npm run dev:server   # 后端 :3000（内置确定性 AI，无需任何 Key）
npm run dev:h5                 # 前端 :5175 → 打开 http://localhost:5175
```

注册账号 → 设置页可跳过 → 首页「导入故事」→ 导入后索引 → 选故事开跑。多人联机：首页「多人联机」→ 创建房间 → 分享房间码。

**接入真实 AI（BYOK）**：启动后打开 设置 → AI 提供商 → 选协议（OpenAI 兼容最通用）→ 填 Base URL / 自己的 API Key → 刷新模型列表并选择 → 保存 → 测试连接 ✓。Key 只存你自己服务端的加密库，随时可玩真实 LLM。

**三端运行**：

| 端 | 命令 | 说明 |
|---|---|---|
| 后端 | `npm run dev:server` | :3000，全部 AI 调用服务端代发 |
| H5 | `npm run dev:h5` | :5175，vite 代理同源直连后端 |
| 微信小程序 | `npm run build:mp-weixin` | 产物 `client/dist/build/mp-weixin`，微信开发者工具导入 |
| App | `npx uni build -p app` 或 HBuilderX 云打包 | 需 `VITE_API_BASE` 指向公网 https/wss |

后端环境变量（`server/.env`，全部可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP / WS 监听端口 |
| `JWT_SECRET` | `dev-secret-change-me` | JWT 签名 + apiKey 加密密钥派生源，**生产必设** |
| `MOCK_AI` | 未设置 | `1` = 内置确定性 AI（离线试玩 / E2E），**生产禁用** |
| `DATA_DIR` / `RAG_DATA_DIR` / `UPLOADS_DIR` / `MODELS_DIR` | `server/data*` | 数据 / RAG / 上传 / 模型缓存目录 |

## 测试与质量

```bash
npm run test:all      # server 457 用例 + client 113 用例（vitest，全绿基线）
npm run test:e2e:h5   # H5 单人全旅程 14 步（真实浏览器，MOCK_AI 自启后端）
node e2e/rooms.journey.mjs      # 多人房间 UI 全链 14 步（双浏览器）
node e2e/multiroom.journey.mjs  # 多人房间 WS 协议 14 步（双客户端）
```

- **E2E 旅程**覆盖：注册登录 → 导入/索引 → 建卡（选职业/投骰/兴趣）→ 开局 → 侦查（skill_check → grant_clue）/ 战斗（roll_dice → adjust_hp，HP 精确断言）→ 读档恢复；多人全链（建房 → 等待室绑卡/就绪 → 门闩 409 → 开局 → 队友档案切换 → 聊天）；
- **真实 LLM 冒烟**：`e2e/byok-smoke.mjs`（需自备 Key：`E2E_REAL_API_KEY=sk-... node e2e/byok-smoke.mjs`，验证 settings 加密存储 → 不回传 → models → chat）；
- **Agent 工作流套件**：`test-agent/`（真实 LLM 驱动，不改项目代码）——调查 / 战斗 / SAN / 存档 / 门控 / 鲁棒性 / 性能；
- 依赖安全：npm audit 实时核对，server 运行时 high 漏洞 = 0（express 5 + overrides 强升，见 `docs/DEPENDENCY-AUDIT-2026-09-04.md`）。

## 文档索引

| 文档 | 内容 |
|---|---|
| `docs/adr/` | 架构决策记录 0001–0005（房间域 / 单人=单成员房 / LLM 协议一等公民 / UI 重设计 / 多人房间流程） |
| `CONTEXT.md` | 领域术语统一（等待室 / 开局门闩 / 就绪 / 房主转让 / RoomClient …） |
| `docs/DEPLOYMENT.md` | 部署上线指南（含 BYOK 玩家引导、安全基线、回滚） |
| `docs/api-contract.md` | 前后端 API 契约（唯一接口基准） |
| `docs/ARCHITECTURE-MULTIPLAYER.md` | 多人架构细节 |
| `docs/DEPENDENCY-AUDIT-2026-09-04.md` | 依赖漏洞联网复核 + 处置记录 |

## 项目状态

- **MVP 完成**：单人 + 多人全功能闭环落地 main；OPEN issue = 0；回归全绿（server 457 / client 113 / E2E 14×3）；
- 主要里程碑：Electron → 服务端重构（ADR-0002）→ LLM 协议化（ADR-0003）→ UI 全面重设计（ADR-0004）→ 多人房间（ADR-0005）→ BYOK / 依赖安全收口；
- 路线图候选（未立项）：saves 迁移、流式输出、A3 userGraph、observer 观战、多人结局、故事共享。

## 安全设计

- **认证**：JWT + bcrypt；WS `?token=` 校验（无效 4001）；房间邀请码 + owner 校验 + 角色卡归属校验；
- **Key 保护**：AES-256-GCM 加密落库、GET 不回传、服务端代发（BYOK）；
- **SSRF 防护**：所有出站 URL 过 `outboundUrl.ts`（拒绝 localhost / 私网 / 保留地址，本地端点不豁免）；
- **路径安全**：外部 id 只进 DB，文件系统只用内部 uuid 文件名（realpath + assertId）；
- **规则服务端权威**：骰子 / 检定 / 伤害全在服务端（防作弊），客户端无规则逻辑；
- **错误不泄栈**：统一 `{ error }` JSON，未知错误 500 通用文案。

## 说明

- `MOCK_AI=1` 只替换 LLM 输出（确定性脚本），KP Agent 的 LangGraph 状态机真实运行——测试与演示等价于真实链路；
- `shared/` 为纯 TS 源码包（无构建），server / client 相对路径直接引用；
- 剧本结构化门控字段（`requiredClues`）为可选扩展：自由文本剧本行为与无门控完全一致，零回归。
