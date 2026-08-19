# COC AI KP — AI 守密人（uni-app 多端重构，monorepo）

COC 7th 规则 AI 跑团助手：由原 Electron 单机应用重构为 **H5 + 微信小程序 + App** 三端架构。
Express + TypeScript 后端承载原主进程逻辑（认证、SQLite 持久化、LangGraph KP Agent、RAG 检索、WebSocket 流式），
uni-app (Vue 3 + Pinia) 前端，SQLite（Node 24 内置 `node:sqlite`）持久化，零原生依赖。

> 核心玩法闭环：**导入剧本 → RAG 索引 → 创建角色 → 与 AI 守密人对话 → 工具链驱动探索/战斗/SAN 检定 → 线索门控推进剧情 → 结局结算 → 存档/读档**。

## 目录结构

```
AI-COC-KP/
├── server/        # Node.js/Express + TypeScript 后端（JWT 认证、SQLite、LangGraph、RAG、WebSocket）
├── client/        # uni-app (Vue 3 + Pinia) 前端（H5 / 微信小程序 / App）
├── shared/        # 共享 TS 源码包（类型定义、COC 工具定义、provider 清单），两端相对路径引用
├── e2e/           # H5 端到端测试（Playwright-core + MOCK_AI 后端，无需真实 LLM）
├── test-agent/    # 独立 Agent 工作流测试套件（真实 LLM，含回归验证；不改项目代码）
├── tools/         # 微信小程序自动化测试（miniprogram-automator）
├── docs/          # MIGRATION-PLAN.md（重构计划）、api-contract.md（前后端 API 契约）
└── original/      # 原 Electron 项目（只读参考，禁止修改）
```

- 整体计划：`docs/MIGRATION-PLAN.md`
- API 契约（前后端唯一接口基准）：`docs/api-contract.md`
- 测试报告与改进记录：`test-agent/REPORT.md`

## 环境要求

- Node.js >= 24（依赖内置 `node:sqlite`，零原生依赖）
- H5 端到端测试需要本机安装 Microsoft Edge 或 Google Chrome（`playwright-core` 不下载浏览器）
- 真实 LLM 测试（test-agent）需配置一个 OpenAI 兼容的 LLM 端点（见下文「AI 配置」）

## 安装

```bash
npm install    # 安装全部 workspace 依赖（client 为 uni-app，体积较大属正常）
```

## 三端运行

### 1. 后端（默认 http://localhost:3000）

```bash
npm run dev:server        # 或 cd server && npm run dev（tsx watch）
```

服务端环境变量（`server/.env` 或命令行注入，全部可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `JWT_SECRET` | `dev-secret-change-me` | JWT 签名密钥 + apiKey 加密密钥派生源，**生产环境必须覆盖** |
| `MOCK_AI` | 未设置 | `1` = 所有 AI/LLM 调用替换为确定性内置脚本（无需 API Key、无外发请求、不下载模型），用于测试与演示 |
| `DATA_DIR` | `server/data` | SQLite 数据目录 |
| `RAG_DATA_DIR` | `server/data/rag` | RAG 向量/图谱数据目录 |
| `UPLOADS_DIR` | `server/uploads` | 上传的故事/剧本文件目录 |
| `MODELS_DIR` | `server/data/models` | 内置嵌入模型缓存目录 |
| `TESSERACT_DATA_DIR` | `server/assets/tesseract` | PDF OCR 语言包目录 |
| `MAX_UPLOAD_BYTES` | `52428800` | 上传大小上限（50MB） |
| `LOG_LEVEL` | `info` | 日志级别 |

### 2. H5 前端（开发模式，http://localhost:5175）

```bash
npm run dev:h5
```

- H5 dev 默认**同源直连后端**：vite 代理 `/api → http://localhost:3000`、`/ws → ws://localhost:3000`（见 `client/vite.config.js`，已显式 `host: 127.0.0.1` 规避 IPv6 EACCES），无需额外配置。
- 如后端不在 3000 端口，用 `VITE_API_BASE` 覆盖：`VITE_API_BASE=http://localhost:3001 npm run dev:h5`。
- 小程序/App 端必须显式设置 `VITE_API_BASE` 为绝对 URL（如 `https://your-server.com`），无合理相对默认值。

### 3. 微信小程序（mp-weixin）

```bash
cd client
npm run build:mp-weixin    # 产物输出到 client/dist/build/mp-weixin
```

然后：

1. 打开微信开发者工具 → 导入项目，目录选择 `client/dist/build/mp-weixin`。
2. AppID 选择测试号（或填入自己的小程序 AppID）。
3. 开发者工具中点击「编译」。真机预览需：小程序后台把服务器域名加入 request/uploadFile/socket 合法域名（https/wss），或开发者工具中勾选「不校验合法域名」。
4. 构建时传入后端地址：`VITE_API_BASE=https://your-server.com npm run build:mp-weixin`。

### 4. App（5+ App / iOS / Android）

```bash
cd client
npx uni build -p app        # App 产物输出到 client/dist/build/app
```

或使用 HBuilderX 云打包（无需本地原生环境）：

1. 用 HBuilderX 打开 `client/` 目录（HBuilderX 直接识别 uni-app 工程）。
2. 菜单 发行 → 原生App-云打包 → 选择 Android/iOS 证书（测试可用公共测试证书）→ 打包。
3. 后端必须为公网可访问的 https/wss 地址，构建时设置 `VITE_API_BASE=https://your-server.com`。
4. 打好的 apk/ipa 安装到真机即可；iOS 需签名/上架流程。

## AI 配置

服务端持有 AI 配置（apiKey 以 AES-256-GCM 加密落库，GET 时省略不回传）。两种方式：

**方式 A — 界面配置（推荐）**：启动后打开 H5 设置页（`/pages/settings/index`），登录后在「AI 设置」选择 provider、填 Base URL / API Key / 模型名，保存后即可使用。

**方式 B — MOCK 模式（零配置，测试/演示）**：`MOCK_AI=1 npm run dev:server`，所有 LLM 调用替换为 `server/src/services/mockAi.ts` 的确定性脚本（真实 LangGraph 状态机照跑，仅 LLM 输出被脚本替换），无需任何 API Key 与网络。

支持的 provider（`shared/constants/providers.ts`）：预设 **openai / openrouter / deepseek / gemini / vllm / ollama**；自定义 **openai_compatible / anthropic_compatible / google_compatible / deepseek_compatible**。服务端按协议自动选择适配器（OpenAI SDK / Anthropic SSE / Google SSE），所有出站请求先过 `server/src/utils/outboundUrl.ts` 的 SSRF 防护（拒绝 localhost/私网/保留地址）。

## 核心架构：KP Agent 工作流

AI 守密人由 **服务端 LangGraph 状态机** 驱动，每轮玩家消息执行一次完整图流程：

```
analyzeInput（意图分类 LLM + 程序化短路）
  ├─ 工具续接检测：上轮有工具结果 → tool_continuation（跳过分类）
  ├─ 结局检测：玩家表达"结束冒险/团灭/成功逃离…" → endgame（强制 end_game）
  └─ SAN 历史检测：历史 san_check 损失 ≥5 或累计 ≥1/5 当前 SAN → san_encounter（强制 trigger_insanity）
  → routeByIntent（combat / sanity / narrative / resource / generic 五路）
  → PlanTools（程序化：必调工具清单 + 停滞强制 + 线索门控）
  → Generate（LLM 生成叙事 + 工具调用）
  → Validate（缺工具/文本模拟骰子检测）
  → forceTools（工具专用 LLM 重试，最多 1 次）→ END
```

关键设计：

- **工具循环在客户端**：服务端每次 invoke 返回 `toolCalls`，客户端执行工具（掷骰/改属性/加线索/切场景），把 `role:'tool'` 结果回传再发下一次 invoke（`client/src/services/kpSessionService.ts`，最多 8 轮）。
- **18 个 COC 工具**（`shared/tools/cocTools.ts` 单一来源）：`skill_check / opposed_check / san_check / roll_dice / adjust_hp / first_aid / adjust_san / adjust_mp / medicine / spend_luck / transition_scene / grant_clue / end_game / trigger_insanity / apply_major_wound / reset_day / melee_attack / ranged_attack`；客户端 5 个 handler（`client/src/toolCalling/handlers/`）执行，orchestrator 按名路由。
- **确定性兜底**（不依赖 LLM 自觉）：SAN 损失超阈值强制 `trigger_insanity`；结局表达强制 `end_game`；连续无进展轮次（历史计数 ≥2 强制给线索、≥4 强制切场景）。
- **线索门控**（`server/src/agent/scriptContext.ts`）：剧本 JSON 可携带结构化 `clues[].requiredClues` / `scenes[].requiredClues`，服务端据此**程序化判定**场景解锁与可授线索（未解锁 → 提示缺失线索且不切场景；已解锁 → 提示可切换）；原仓库自由文本剧本（`obtainCondition`/`transitionCondition`）降级为参考文本，零回归。客户端通过 WS 帧的 `storyContext`（scriptId/openClues/sceneName）上报状态。
- **流式传输**：WS `/ws?token=` 帧 `chunk / trace / end / error`，同一连接多 streamId 并发隔离；trace 事件（intent_classified / agent_routed / tool_plan_created / llm_generate_start / llm_generate_end / validation_result / force_tools_invoked）供前端 DebugPanel 实时展示。
- **上下文管理**：客户端保留最近 18 条消息进 prompt（`CONVERSATION_WINDOW`），工具结果回传截断 600 字符；每 5 回合 / 场景切换 / 高影响工具回合触发 LLM 长程摘要（`memoryService`）。

## RAG 检索（剧本知识）

剧本（txt/md/json/pdf/docx/epub/html）上传后索引两套：

- **向量索引**（`server/src/rag/vectorStore.ts`）：TF-IDF + 稠密向量混合（内置 `text2vec-base-chinese-sentence` 或 OpenAI 兼容 embedding API），分块 800/重叠 100。
- **图索引**（`server/src/rag/graphStore.ts` + `graphExtractLLM.ts`）：LLM 抽取实体/关系 → union-find 社区检测 → 社区摘要；运行时向量召回 → BFS 2 跳图扩展 → 结构化上下文（社区摘要/当前场景/关联节点/线索）。
- **玩家会话图**（`user_graphs` 表）：记录每局获得的线索/到访场景/遭遇事件，供摘要与结局回溯。

检索在 `POST /api/rag/context`，客户端每轮消息前自动取上下文注入 prompt；PDF 支持 OCR（tesseract.js chi_sim+eng）。

## 测试

```bash
npm run test:server    # 后端 vitest（220 用例，含 MOCK_AI 分支、kpGraph 状态机、消息校验、门控）
npm run test:client    # 前端纯逻辑测试（vitest）
npm run test:all       # server + client 全部单测
npx tsc --noEmit       # client 类型检查（零错误基线）
```

### H5 端到端测试（无需真实 LLM）

```bash
npm run test:e2e:h5    # 等价于 node e2e/h5.journey.mjs
```

脚本自动：

- 以 `MOCK_AI=1 PORT=3100` 启动后端、以 `VITE_API_BASE=http://localhost:3100` 启动 H5 dev（端口 5175），测试完自动清理；
- 用本机 Edge/Chrome（playwright-core，不下载浏览器）走完整旅程：注册登录 → 设置保存 → 导入 `e2e/fixtures/demo-story.txt` → RAG 索引 → 首页选故事 → 选职业（法官）→ 创建角色（投骰 + 兴趣技能 + 姓名）→ 游戏开场 → 侦查消息（skill_check → grant_clue 工具闭环，线索+1）→ 战斗消息（skill_check → roll_dice → adjust_hp 闭环，HP -2）→ 存档 → 读档 → 恢复断言 → 截图（`e2e/screenshots/`）。

环境变量覆盖（用于复用外部服务或换浏览器）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `E2E_API_BASE` | `http://localhost:3100` | 后端地址；设置后脚本不再自启后端 |
| `E2E_WEB_BASE` | `http://localhost:5175` | H5 地址；设置后脚本不再自启前端 |
| `E2E_BROWSER` | 自动探测 msedge→chrome→已知路径 | 也可填浏览器可执行文件路径 |

失败时输出每步 PASS/FAIL 与耗时，并在 `e2e/screenshots/` 保存失败截图 + 页面 HTML dump。

### Agent 工作流测试（test-agent，真实 LLM）

独立测试套件（`test-agent/`），**不修改项目代码**，直接经 HTTP + WS 驱动服务端，验证 Agent 工作流的完整性/鲁棒性/性能。需要 OpenAI 兼容端点（自动读取本机 ZCode opencode/mimo-v2.5 配置，或用环境变量覆盖）：

```bash
export AW_BASE_URL=https://opencode.ai/zen/go/v1   # 可选，默认自动发现
export AW_API_KEY=<key>                            # 可选
export AW_MODEL=mimo-v2.5                          # 可选

cd test-agent
node run-all.mjs           # 全部场景（约 15-20 分钟，含 LLM 推理）
node smoke.mjs             # 连通性冒烟
node scenario-investigate.mjs   # 调查链（12 用例，线索门控）
node scenario-combat.mjs        # 战斗链（5 用例）
node scenario-sanity.mjs        # SAN/疯狂链（5 用例）
node scenario-save.mjs          # 存档/读档（6 用例）
node scenario-gating.mjs        # 门控/确定性行为回归（7 用例）
node robustness.mjs             # 鲁棒性（8 用例）
node performance.mjs            # 性能测量（5 项）
```

完整用例结果、改进点与修复记录见 `test-agent/REPORT.md`（36 用例 + 门控回归 7 用例全部通过）。

### 微信小程序自动化测试（开发者工具真实运行时）

在微信开发者工具（游客/测试号登录）中验证小程序真实运行时，而非仅构建产物：

```bash
cd tools/mp-test
npm i miniprogram-automator     # 首次
node patch-automator.mjs        # 兼容新版 IDE（Tool.getInfo 返回结构变化，幂等）
node mp-test.mjs                # 连接 ws://localhost:9420 跑冒烟断言
```

前置条件（缺一不可）：

1. 微信开发者工具**以管理员身份启动**（自动化端口 9420 才会绑定）；
2. 设置 → 安全设置 → **服务端口** 开启；
3. 导入本项目构建产物 `client/dist/build/mp-weixin`（AppID 选测试号；构建命令见上文）。

覆盖断言（实测 **7/7 通过**，2026-08-16，DevTools 2.02.2608031 游客模式）：连接自动化 → 首页渲染（关键文案"AI COC Keeper / 克苏鲁的呼唤 — 智能守密人"等）→ 首页按钮 → 设置页（登录/配置输入框与文案）→ 返回首页。

踩坑记录（详见 `tools/mp-test/` 与设备端测试文档）：

- 自动化端口需管理员启动开发者工具；官方 `cli.bat` 存在 setlocal 递归 bug，可用 electron bootstrap 方式调用 CLI（`cli open-other` 可绕过游客 appid 校验）；
- 新版 IDE 的 `Tool.getInfo` 返回 `version` 字段，旧版 miniprogram-automator 的 `checkVersion` 会崩溃 → `patch-automator.mjs` 修补；
- 小程序端 API 调用需在开发者工具勾选「不校验合法域名」或在小程序后台配置 request/uploadFile/socket 合法域名。

### Android 模拟器验证（App 端）

用 Android SDK 模拟器（Pixel 5 / Android 14，WHPX 加速）加载 H5 构建验证 App 端逻辑（原生壳打包见上文 App 章节）：

```bash
# 构建指向宿主机的 H5（10.0.2.2 = 模拟器访问宿主机回环）
VITE_API_BASE=http://10.0.2.2:3000 npm --prefix client run build:h5
# 模拟器内 Chrome 打开 http://10.0.2.2:8080（静态服务 8080 + 后端 3000 MOCK_AI）
```

实测：首页完整渲染（无报错/白屏）；`nc 10.0.2.2 3000` 返回 401 + CORS 头（后端可达）。注意：重启 WinNAT 服务会破坏模拟器 Netsim 网络栈导致崩溃，启动时加 `-feature -Netsim`。

## CI / 发布

- **CI**（`.github/workflows/ci.yml`）：push/PR 到 main 触发——`npm ci` → server 单测 → client 单测 → 构建 → e2e H5（MOCK_AI）。
- **发布**（`.github/workflows/release.yml`）：打 tag `v*` 触发——构建产物上传 GitHub Release（幂等：release 已存在时补传资产）。

## 构建

```bash
cd server && npm run build      # tsc 编译到 server/dist（先清理旧产物），node dist/server/src/app.js 运行
cd client && npm run build:h5   # H5 产物 client/dist/build/h5（先清理旧产物）
cd client && npm run build:mp-weixin
```

## 安全设计

- 认证：JWT（30 天）+ bcrypt 密码哈希；WS 以 `?token=` 校验，无效关闭 4001。
- apiKey：AES-256-GCM 加密落库（密钥派生自 `JWT_SECRET`），GET 设置不回传。
- SSRF 防护：所有出站 URL 过 `outboundUrl.ts`（拒绝 localhost/私网/回环/保留地址）。
- 路径安全：上传/读取一律经 `pathSafety.ts`（realpath 防符号链接逃逸、`assertId` 消毒）；文件按 userId 隔离。
- 错误不泄栈：统一 `{ error: string }`，未知错误 500 通用文案。
- 输入校验：kp:invoke 消息严格校验（非数组 400、tool_calls 结构校验、坏参数 JSON 降级 `'{}'`）。

## 说明

- `MOCK_AI=1` 仅影响 AI 调用路径（`server/src/services/mockAi.ts`），非 mock 路径行为完全不变（有单测证明）；KP Agent 的 LangGraph 状态机在 mock 模式下真实运行，仅 LLM 调用被确定性脚本替换（含 侦查→skill_check→grant_clue、战斗→skill_check→roll_dice→adjust_hp 等工具链）。
- `shared/` 为纯 TS 源码包（无构建步骤），server 与 client 通过相对路径直接引用。
- 服务端发起任何外部 URL 请求前必须通过 `server/src/utils/outboundUrl.ts` 校验（拒绝 localhost/私有/保留地址）。
- 剧本结构化门控字段（`requiredClues`）为可选扩展：无该字段的自由文本剧本（如原仓库）行为与迁移前完全一致。
