# AI-COC-KP 新人入职分析报告（从 0 到 1 项目全解）

> 编写日期：2026-08-19 · 版本：0.1.0（feature/coc7-rules-perf-optimization）
> 阅读对象：新入职工程师。本文基于对当前代码库的完整通读 + `test-agent/REPORT.md` 实测结论编写，
> 与 `README.md`（运行）、`docs/api-contract.md`（接口契约）、`docs/MIGRATION-PLAN.md`（重构计划）、
> `docs/PROJECT-ANALYSIS.md`（模块级分析）互为补充。本文按「为什么做 → 怎么做 → 现在长什么样 → 怎么调 → 怎么测 → 坑在哪」的顺序组织。

---

## 目录

1. [项目立项：这是什么，为什么存在](#一项目立项)
2. [需求：Functional / Non-Functional](#二需求functional--non-functional)
3. [技术选型与对比](#三技术选型与对比)
4. [Monorepo 结构与模块地图](#四monorepo-结构与模块地图)
5. [后端核心：KP Agent 工作流（LangGraph 状态机）](#五后端核心kp-agent-工作流langgraph-状态机)
6. [线索门控：剧本结构化与程序化判定](#六线索门控剧本结构化与程序化判定)
7. [RAG 检索系统（剧本知识）](#七rag-检索系统剧本知识)
8. [AI 协议适配层与 MOCK_AI](#八ai-协议适配层与-mock_ai)
9. [前端核心：gameStore 与工具执行链](#九前端核心gamestore-与工具执行链)
10. [平台抽象层 Bridge 与 WebSocket](#十平台抽象层-bridge-与-websocket)
11. [数据模型与持久化](#十一数据模型与持久化)
12. [安全设计](#十二安全设计)
13. [Agent 工作流调优：从问题到修复](#十三agent-工作流调优从问题到修复)
14. [测试体系](#十四测试体系)
15. [性能特征与已知瓶颈](#十五性能特征与已知瓶颈)
16. [遗留项与技术债](#十六遗留项与技术债)
17. [新手指南：从哪里开始读代码](#十七新手指南从哪里开始读代码)

---

## 一、项目立项

**一句话定位**：这是一个「克苏鲁的呼唤第七版（COC 7th）」规则 AI 跑团助手——玩家导入剧本（模组），与一个由大语言模型驱动的 AI 守密人（Keeper，简称 KP）进行文字冒险。KP 不只是聊天，它用一套 **LangGraph 状态机 + 18 个 COC 规则工具** 驱动探索、战斗、理智检定、线索收集与结局结算，并用 **RAG** 从剧本原文中检索知识、防止剧透。

**立项背景**（从 `docs/MIGRATION-PLAN.md` 与 git 历史还原）：

- 项目最初是一个 **Electron 单机桌面应用**（Vue 3 + Vite + Electron），仓库 `sunnyday9/COC-AI-KP`。渲染进程通过 `window.electronAPI`（约 40 个 IPC 方法）与主进程通信，主进程承载 AI 对话（OpenAI SDK）、KP Agent（LangGraph 状态机）、三层 RAG、文档解析（PDF/OCR/DOCX/EPUB）等全部逻辑。
- 重构动机：**Electron 单机形态无法支持多端、多用户与云端化**。settingsStore 里预留的 `syncServerUrl` 字段证明团队早有「同步服务器」的伏笔。
- 2026-08-15 立项重构：将 Electron 版重写为 **server / client / shared 三包 monorepo**，后端 Express 承载原主进程全部逻辑，前端 uni-app 支持 **H5 + 微信小程序 + App** 三端，Electron 完全替换。
- 当前分支 `feature/coc7-rules-perf-optimization` 的最新提交（e2c522a）标志着 **COC 7th 规则书合规 + 工作流性能优化** 这一阶段的完成：36 个真实 LLM 测试用例全部通过，7 个改进点全部闭环，又新增了 7 个门控回归用例。

**git 历史时间线**（重要节点）：

```
af440a7 chore: 清理 mimosa hook 状态/死测试/字面量夹具，加路径守卫
6cc0efd chore: v0.1.0，加 GitHub Actions CI + release 工作流
c9c800e ci: release 工作流幂等化
bb29e30 docs: 设备端测试（小程序自动化 + Android 模拟器）结果与工具
e2c522a feat(agent): COC-7th 规则书合规 + 工作流性能优化 ← 当前 HEAD
```

---

## 二、需求（Functional / Non-Functional）

### 2.1 Functional Requirements（功能需求）

| 编号 | 需求 | 实现位置 |
|---|---|---|
| FR-1 | 用户注册/登录，多用户数据隔离 | `server/src/routes/auth.routes.ts`，JWT 30 天 |
| FR-2 | 导入剧本（txt/md/json/pdf/docx/epub/html），PDF 支持 OCR | `server/src/rag/storyParsers.ts` |
| FR-3 | 剧本 RAG 索引（向量 + 图谱），供对话时检索知识 | `server/src/rag/*` |
| FR-4 | 创建 COC 7th 角色（职业/属性投骰/技能/姓名） | `client/src/pages/character/*` + `logic/coc7Character.ts` |
| FR-5 | 与 AI 守密人文字对话，流式输出（WS） | `client/src/stores/gameStore.ts` + `server/src/ws/index.ts` |
| FR-6 | 工具链驱动规则：检定/战斗/SAN/幸运/医疗/场景/线索/结局等 18 个 COC 工具 | `shared/tools/cocTools.ts`（定义）+ `client/src/toolCalling/`（执行） |
| FR-7 | 确定性兜底：SAN 超阈值强制疯狂、结局表达强制 end_game、停滞强制推进 | `server/src/agent/kpGraph.ts` |
| FR-8 | 线索门控：剧本结构化 `requiredClues` 程序化判定场景解锁 | `server/src/agent/scriptContext.ts` |
| FR-9 | 存档/读档（全量快照：角色/线索/场景/消息/结局） | `server/src/services/saveService.ts` |
| FR-10 | 结局结算 + 结局报告（含关键事实/回顾） | `client/src/pages/game/game-end/` |
| FR-11 | AI 设置（provider/baseUrl/key/model）服务端持久化 | `server/src/services/settingsService.ts` |
| FR-12 | 三端一致：H5 / 微信小程序 / App | `client/src/platform/bridge.ts` |
| FR-13 | 调试面板（RAG 检索调试、KP trace 实时展示） | `client/src/pages/rag-inspector/` + `DebugPanel.vue` |

### 2.2 Non-Functional Requirements（非功能需求）

| 类别 | 需求 | 实现 |
|---|---|---|
| NFR-1 安全 | API Key 不落前端；JWT 认证；WS 鉴权；SSRF 防护；路径穿越防护；错误不泄栈 | 见 §12 |
| NFR-2 可测试性 | 无真实 LLM 也能全链路测试（确定性脚本）；CI 全自动 | `MOCK_AI=1` + `e2e/`，见 §14 |
| NFR-3 性能 | 单轮响应 10-15s（受 LLM 推理主导）；图超时 120s 兜底；非流式 LLM 60s 超时 | `kpAgentService.GRAPH_TIMEOUT_MS` + `aiService.LLM_REQUEST_TIMEOUT_MS` |
| NFR-4 零原生依赖 | Node ≥ 24 内置 `node:sqlite`；embedding 用 transformers.js（WASM） | `server/src/db/index.ts` |
| NFR-5 鲁棒性 | 输入强校验；LLM 坏输出可自纠；工具循环失败不卡死 | `normalizeMessages` + validate→forceTools + 8 轮上限 |
| NFR-6 可维护性 | 前后端契约单一来源（`shared/` + `docs/api-contract.md`）；工具定义单一来源 | §4 |
| NFR-7 部署 | Docker 友好（零原生依赖）、GitHub Actions CI + Release | `.github/workflows/` |

---

## 三、技术选型与对比

| 层面 | 选型 | 对比过什么 / 为什么 | 备注 |
|---|---|---|---|
| 后端框架 | Express + TypeScript (ESM) | NestJS（重）、Fastify（生态）——原主进程代码是 CJS/MJS，Express 迁移成本最低，路由级迁移可直接对应原 IPC handlers | `server/src/app.ts` |
| 数据库 | SQLite（Node 24 内置 `node:sqlite`） | Prisma + SQLite（计划书初选）→ 最终弃用 Prisma，改手写 `DatabaseSync` 单例：零原生依赖、无构建步骤、无需迁移工具（幂等建表） | 代价：无迁移机制（§16） |
| 状态机 | LangGraph（`@langchain/langgraph`） | 纯手写状态机（难维护）、LangChain 全量（重）——LangGraph 提供图式声明 + 条件边，且与原 Electron 版一脉相承 | 5 个 agent 变体共享 validate/forceTools |
| WebSocket | `ws` | Socket.IO（协议重、小程序不友好）——原生 WS 协议 + 自定义 JSON 帧，小程序 `uni.connectSocket` 直接兼容 | 单连接多 streamId 并发 |
| 认证 | JWT + bcrypt | Session（有状态、跨端难）——无状态、30 天有效期、WS 用 `?token=` 复用 | |
| AI 协议 | 自研三适配器：OpenAI 兼容 / Anthropic SSE / Google SSE | 直接用 openai SDK 只覆盖一家——用 `shared/constants/providers.ts` 的 provider→protocol 映射，预设 6 家 + 自定义 4 种兼容协议 | 全部出站请求过 SSRF 防护 |
| 前端框架 | uni-app (Vue 3 + Pinia + Vite) | 原生小程序（三端三套代码）、Flutter（学习成本）——一套代码三端编译 | Tailwind → UnoCSS 保留 utility-first |
| 向量检索 | 自研 TF-IDF + 字符 n-gram（中文分词） | Python rag-service（原仓库遗留，重）、向量数据库（部署成本）——纯 JS 实现，字符 1-3 gram + 英文单词 token，余弦相似度 | 详见 §7 |
| 图谱检索 | 自研 GraphRAG（LLM 抽取 → union-find 社区 → LLM 社区摘要） | Microsoft GraphRAG（Python、重）——COC 领域定制 prompt，实体/关系/社区摘要 | |
| Embedding | transformers.js 本地模型优先，OpenAI 兼容 API 回退 | 多用户后端本地推理是瓶颈（计划书 R2）——默认可切换 | |
| 测试 | vitest + playwright-core + miniprogram-automator + 自研 test-agent | 见 §14 | |

**核心架构决策：工具循环在客户端**（`docs/MIGRATION-PLAN.md` R1 风险 + task-3-brief decision）。原 Electron 版工具执行在主进程；新架构改为：**服务端每次 `kp:invoke` 只跑一次 LangGraph，返回 `{content, toolCalls}`；客户端拿到 toolCalls 后用本地 5 类 handler 执行（掷骰/改属性/加线索），把 `role:'tool'` 结果回传再发下一次 invoke，最多 8 轮**。这带来：

- ✅ 服务端无状态（每 invoke 新图实例），天然可水平扩展；
- ✅ 角色状态真源在客户端（gameStore），多端可各自持有；
- ⚠️ 代价：长对话上下文在客户端反复上传，工具链轮次时延线性放大（§15）。

---

## 四、Monorepo 结构与模块地图

```
AI-COC-KP/
├── server/                    # Node.js/Express + TypeScript 后端
│   └── src/
│       ├── app.ts             # Express 工厂：cors + json(1mb) → 8 组路由 → 404 → 错误处理；直跑时 listen + WS
│       ├── config.ts          # 环境变量（PORT/JWT_SECRET/MOCK_AI/DATA_DIR/…）
│       ├── db/index.ts        # node:sqlite 单例，懒建 7 张表
│       ├── middleware/auth.ts # JWT 签发/校验 + requireAuth
│       ├── agent/             # ★ 智能核心
│       │   ├── kpGraph.ts     #   LangGraph 状态机（1133 行，见 §5）
│       │   └── scriptContext.ts # 剧本结构化加载 + 线索门控（见 §6）
│       ├── routes/            # auth/settings/ai/kp/stories/scripts/saves/rag 8 组
│       ├── services/          # aiService / kpAgentService / mockAi / settings / save / story / script / rag
│       ├── rag/               # embedding / vectorStore / graphStore / graphExtractLLM / graphRag / userGraphStore / storyParsers / prompts/
│       ├── ws/                # /ws（token 鉴权、kp:invoke 流式、rag:progress 推送）
│       └── utils/             # errors / logging / crypto / outboundUrl(SSRF) / pathSafety / fileNames / fsSafe
├── client/                    # uni-app (Vue 3 + Pinia)
│   └── src/
│       ├── pages/             # home / scripts / settings / rag-inspector(H5 only) / game(+game-end) / character(occupation+create)
│       ├── stores/            # gameStore(核心 857 行) / settingsStore / storyStore / debugStore
│       ├── services/          # kpSessionService(工具循环) / kpPromptService(prompt 组装) / memory* / rag* / ai* / save* / tracing*
│       ├── toolCalling/       # orchestrator + 6 handlers（18 工具执行）+ types
│       ├── logic/             # coc7Character(角色生成) / coc7Rules(检定公式) / healingRules / environmentRules / growthRules
│       ├── data/              # coc7.ts(静态规则数据) / insanityTables.ts(恐惧症/躁狂症发作表)
│       ├── platform/          # bridge(三端抽象) / ws / config / token
│       └── composables/       # useGameGuard / useToast
├── shared/                    # 纯 TS 源码包（无构建），两端相对路径引用
│   ├── types/                 # bridge / storyContext / ending / game / character / script / settings
│   ├── tools/cocTools.ts      # 18 个 COC 工具 schema ★单一来源（433 行）
│   └── constants/providers.ts # provider 清单（6 预设 + 4 自定义）
├── e2e/                       # H5 端到端（playwright-core + MOCK_AI，无需真实 LLM）
├── test-agent/                # 独立 Agent 工作流测试（真实 LLM，不改项目代码）
├── tools/mp-test/             # 微信小程序自动化（miniprogram-automator）
├── docs/                      # MIGRATION-PLAN / api-contract / PROJECT-ANALYSIS / 本报告
└── original/                  # 原 Electron 项目（只读参考，禁止修改）
```

**关键原则**：
- **shared/ 是契约的单一来源**：工具定义（`cocTools.ts`）、provider 清单、全部跨端类型。服务端 tools 参数、客户端 handler 校验都从这里来（orchestrator 的 DEV 校验会警告「有定义无 handler」）。
- **服务端无状态**：除内存缓存（graphCache / scriptContext cache / graphStore memoryCache）外，一切状态在 DB 或客户端。

---

## 五、后端核心：KP Agent 工作流（LangGraph 状态机）

文件：`server/src/agent/kpGraph.ts`（1133 行）。这是整个项目的心脏。每个节点职责分明，**只有 2 个节点调 LLM，其余全部是程序化逻辑**——这是性能与确定性的根基。

### 5.1 图拓扑

```
START → analyzeInput → routeByIntent ─条件边→ {generic|combat|sanity|narrative|resource}Plan
      → Generate → validate ─条件边→ END | forceTools → validate（最多 1 次重试）
```

`createKPGraph(invokeLLM, userId?)` 把 5 个 agent 变体（generic/combat/sanity/narrative/resource）实例化为 5 组 Plan/Generate 节点，共享同一个 validate 与 forceTools。`routeByIntentEdge` 条件边按意图路由。

### 5.2 节点详解

**① analyzeInput（意图分析）**——三层短路，尽可能跳过分类 LLM：

1. **工具续接检测**（`analyzeToolContinuation`）：消息尾部是连续 `role:'tool'` 消息 → 直接置意图 `tool_continuation`，跳过分类。这是多轮工具链（skill_check → roll_dice → adjust_hp）能跑通的关键。
2. **结局检测**（`detectEndgameIntent`）：正则匹配玩家文本（`结束冒险/团灭/永久疯狂/成功逃离/真相大白/终止游戏/结局吧/到此为止`…）→ 意图 `endgame`。词表刻意收窄，普通移动（"离开房间"）绝不误伤。
3. **SAN 历史检测**（`extractSanStateFromHistory` + `shouldTriggerInsanity`）：扫描历史全部 `san_check` 工具结果，累计损失 ≥5 或 ≥⌊当前SAN/5⌋ → 意图 `san_encounter`（planTools 会强制 `trigger_insanity`）。

都没命中才调分类 LLM（9 意图，maxTokens 32、不挂工具），失败兜底 `narrative`。此外还有 **关键词规则短路**（`classifyIntentByRules`，`INTENT_RULES_ORDER` 表）——正则命中直接返回意图，连分类 LLM 都不调。这条规则表与 mockAi 的 `INTENT_RULES` 刻意保持一致，保证 MOCK 模式与真实模式行为对齐。

**② routeByIntent（程序化路由）**：combat→combat；san_encounter→sanity；investigate/explore/talk_npc/move/tool_continuation/narrative/endgame→narrative；use_item→resource；其余→generic。

**③ PlanTools（程序化，无 LLM）**——`TOOL_PLANS` 表给出每意图的 `required` 工具清单 + 自然语言计划，再叠加 6 个阶段增强：

- **工具续接**：把上轮已调用工具 + 本轮应继续的工具合入 required，并生成【工具续接】提示（防重复调用/防漏步）；
- **停滞强制**：`computeStallLevelFromHistory` 数历史连续无进展回合（进展工具 = grant_clue/transition_scene，**单个 skill_check 不重置计数**）——≥2 强制 `grant_clue`，≥4 强制 `transition_scene`（这是修复"调查只检定不给线索"的核心，§13）；
- **endgame 强制**：`end_game` 必调；
- **SAN 自动检定**（storyContext.sanity.autoCheck）；
- **外部防停滞标志**（storyContext.forceTransitionScene）；
- **sanity agent 阈值**（storyContext.sanity 或历史推导）→ 强制 `trigger_insanity`；
- **resource agent 结构化映射**（文本含"幸运"→spend_luck、"MP/魔法"→adjust_mp、"SAN/理智"→adjust_san）；
- **线索门控**（Phase 3.5，narrative agent + userId + storyContext.scriptId 时加载剧本判定，§6）；
- **generic 护栏**：generic agent 的 required 剔除 transition_scene/grant_clue/end_game 等高影响工具（规则问答不得擅自推剧情）。

**④ Generate（唯一主 LLM 调用）**：把 hintBlock（行动计划 + 必调工具清单 + 故事上下文 + 各 agent 守则 + 输出规则）注入 system 消息，一次调用返回 `{content, toolCalls}`。战斗/sanity/narrative 各有专属守则（"禁止在文字中编造骰子结果"是反复强调的红线）。

**⑤ validate（程序化，无 LLM）**：

- **缺工具检测**：required 工具必须出现在 toolCalls 中。`TOOL_EQUIVALENTS` 处理单向等价——`melee_attack` 隐式满足 skill_check+roll_dice+adjust_hp（反向不成立）；
- **文本模拟检测**（`hasTextSimulation`）：正则扫描 LLM 回复是否在文字里编造了骰子/数值（`d100: 45`、`HP 降至 4`、`受到 5 点伤害`…）——这是防止 LLM"文字作弊"的最后防线；
- 缺工具或模拟 → `missing_tools` → forceTools；重试 ≥1 次 → `max_retries` 放行（`cleanTextSimulation` 先把模拟文本从回复里洗掉再放行，避免污染对话）。

**⑥ forceTools（第二个 LLM 调用）**：工具专用提示词，要求"只输出工具调用，不输出文字"，把缺失工具补齐后合并 toolCalls。**注意**：对历史 assistant 消息的 tool_calls 做规范化（坏 arguments JSON 降级 `'{}'`），防止坏 JSON 在重试路径把上游 LLM 调用打成 400（AW-R-09）。

### 5.3 性能设计（perf 优化重点）

- **图实例缓存**（`kpAgentService.getSharedGraph`）：`createKPGraph` 每次重建整个 StateGraph，而图本身无状态 → 10s TTL 缓存，key 含 invokeLLM 闭包（配置变更→新闭包→新缓存项，绝不串配置）。**流式路径永不缓存**（闭包捕获 per-request onChunk，复用会流向死连接）。
- **120s 图超时**（`GRAPH_TIMEOUT_MS`）+ **60s 非流式 LLM 请求超时**（`LLM_REQUEST_TIMEOUT_MS`）：非流式调用共享图预算，单次挂死不会吃掉整个图；流式以 chunk 活跃度为存活信号，不设固定时钟。
- **trace 事件**：每次 invoke 恰好 6 个 trace（intent_classified / agent_routed / tool_plan_created / llm_generate_start / llm_generate_end / validation_result），供前端 DebugPanel 与 test-agent 断言。

---

## 六、线索门控：剧本结构化与程序化判定

文件：`server/src/agent/scriptContext.ts`。解决的核心问题：**剧本推进不再依赖 LLM 自觉**。

### 6.1 双轨设计（零回归的加法）

原剧本 schema 的 `clues[].obtainCondition` / `scenes[].transitionCondition` 是自由文本，不可机读。本项目在其上新增**可选**结构化字段：

```jsonc
{
  "scenes": [{ "id": "s2", "name": "地下密室", "requiredClues": ["c1"] }],
  "clues":  [{ "id": "c1", "description": "铜钥匙", "requiredClues": ["c0"] }]
}
```

- 结构化字段存在 → **程序化判定**（`sceneUnlocked` 返回 true/false + 缺失清单）；
- 只有自由文本（原仓库剧本）→ 返回 null，条件文本作为**参考提示**注入 prompt，永不拦截 → 行为与迁移前完全一致。

### 6.2 判定函数

| 函数 | 作用 |
|---|---|
| `parseScriptContent` | 剧本 JSON → ScriptContext（宽容解析，坏字段跳过） |
| `loadScriptContext(userId, scriptId)` | 经 storyService.readStory 读取 + 60s TTL 缓存 |
| `findScene(ctx, nameOrId)` | id/名称精确 → 文本包含匹配，**最长名优先**（防"地下"误匹配"地下室"） |
| `sceneUnlocked(scene, obtainedIds)` | `{unlocked: true\|false\|null, missing[]}` |
| `getAvailableClues(scene, obtainedIds, ctx)` | 场景内未获 + 前置满足的线索清单（reason: open / unlocked-by-clue） |
| `getSceneNpcs` | 场景 NPC 列表（prompt 渲染用） |

### 6.3 注入点（kpGraph planTools Phase 3.5）

仅 narrative agent 且带 storyContext（`{scriptId, openClues, sceneName}`）时执行：

1. **移动目标门控**：玩家文本点名一个非当前场景的已知场景 → 锁闭则提示缺失线索 + **从 required 里移除 transition_scene**（物理上禁止硬切）；解锁则提示可切换；
2. **探索门控**：当前场景存在可获线索 → 注入清单 + "请通过 grant_clue 授予"；前置不满足 → 提示"不要强行授予"。

与停滞强制（≥2 强制 grant_clue）配合，形成了"探索回合必有线索产出"的闭环。

**数据来源**：客户端每轮 invoke 经 WS 帧带 `storyContext`（`gameStore.buildStoryContext`：scriptId/openClues/sceneName/sanity/forceTransitionScene）。

---

## 七、RAG 检索系统（剧本知识）

目录 `server/src/rag/`。剧本上传后建立**双索引**，运行时做**向量召回 + 图扩展 + 结构化摘要**。

### 7.1 文档解析（storyParsers.ts）

txt/md 直读；docx 用 mammoth；epub 用 epub2；html 用 jsdom；**pdf 用 pdf-parse 提取文本层，扫描页（无文本层）走 tesseract.js OCR**（chi_sim+eng 语言包在 `server/assets/tesseract`）。分块 800 字符 / 重叠 100。

### 7.2 向量索引（vectorStore.ts，587 行）

- **分词**：中文按字符 1-3 gram + 英文按单词（`[a-z]{2,}`），停用字符表过滤标点；
- **权重**：TF-IDF（`idf = ln((N+1)/(df+1)) + 1`）；
- **混合检索**：TF-IDF 余弦 + 稠密向量（embedding，见 7.4），分数融合；
- **防剧透**：候选分段策略（sceneId 过滤）——未来章节不提前进入检索视野；
- **持久化**：`RAG_DATA_DIR/<userId>/rag_index/<scriptId>.json`，每用户隔离，内存缓存 keyed `userId:scriptId`。

### 7.3 图谱索引（graphStore.ts + graphExtractLLM.ts）

Microsoft GraphRAG 风格本地管线，COC 领域定制：

1. **LLM 抽取**（`extractGraphFromChunksLLM`）：按 2500 字符/3 分块一批，COC 实体类型 prompt（`prompts/cocExtractGraph.ts`）抽取实体与关系，temperature 0、maxTokens 2048，单批失败跳过不中断；
2. **社区检测**：union-find 并查集 → `community_N`；
3. **社区摘要**：每社区 LLM 生成摘要（≤5 个社区，temperature 0.3，失败置空）；
4. **持久化**：`RAG_DATA_DIR/<userId>/graph_index/<scriptId>.json`。

### 7.4 Embedding 双通道（embedding.ts）

内置 `@huggingface/transformers` 本地模型（text2vec-base-chinese-sentence，模型缓存 `MODELS_DIR`）优先，失败回退 OpenAI 兼容 `/v1/embeddings`。

### 7.5 运行时检索（graphRag.ts）

`buildContextWithGraph`：

```
向量召回（topK，sceneId 候选策略）
  → 图 BFS 2 跳扩展（expandFromChunks：chunk→node→邻居→邻接 chunk）
  → 结构化摘要（社区摘要 / 当前场景 / 关联节点(含"需XX后解锁") / 相关线索，边语义 CONTAIN/UNLOCK/TRANSITION）
  → 拼 "## 故事情报（含关系）" + 详细片段
```

**关键设计**：上下文构建**不调 LLM**（否则每轮对话多一次推理）。LLM 综合检索（local/global search prompt）保留在 `prompts/` 但非默认路径。

### 7.6 玩家会话图（userGraphStore.ts）

DB 表 `user_graphs`：每局记录线索获得（clue）/场景到访（scene）/行动（action：技能检定/SAN检定/攻击）。运行时 `GET /api/rag/user-graph/summary` 生成"调查员行动记录"，与 RAG 上下文一起注入 prompt；结局报告也用它回溯。客户端 `gameStore.addClue / transitionToScene / processToolCalls` 处埋点上报。

---

## 八、AI 协议适配层与 MOCK_AI

文件：`server/src/services/aiService.ts`（948 行）+ `shared/constants/providers.ts` + `mockAi.ts`。

### 8.1 Provider → Protocol 映射

预设：openai / openrouter / deepseek / gemini / vllm / ollama；自定义：openai_compatible / anthropic_compatible / google_compatible / deepseek_compatible。`dispatchChat` 按 protocol 分派：

| 协议 | 实现 | 要点 |
|---|---|---|
| openai_compatible | openai SDK（`doOpenAICompat`） | 流式增量聚合 tool_calls（按 index 拼接 arguments 片段） |
| anthropic_compatible | fetch + SSE（`doAnthropic`） | 消息转换（system 抽取、tool_use/tool_result 块、相邻同角色合并、首条非 user 补 `（继续）`）；SSE 解析 content_block_start/delta/stop |
| google_compatible | fetch + SSE（`doGoogle`） | OpenAI schema → Gemini `functionDeclarations` 递归转换；functionCall/functionResponse 往返；**`_thoughtSignature` 双向透传**（从原 aiHandlers.cjs 恢复的行为） |

**统一安全门**：`resolveAiConfig` 在**任何出站请求之前**调用 `assertSafeOutboundUrl(baseUrl)`（§12）。

**统一超时**：非流式 60s（`withRequestTimeout`）；流式不限时。

### 8.2 MOCK_AI 确定性脚本（mockAi.ts）—— 项目可测性的基石

`MOCK_AI=1` 时所有 AI 入口短接到 mockAi：**这不是图的 stub，LangGraph 状态机照跑**，只是每个 LLM 节点由确定性脚本应答：

- 意图分类调用 → 关键词 → 意图词（词表与 kpGraph 的 `INTENT_RULES_ORDER` 一致）；
- 新回合生成 → 关键词 → 工具链起点："战斗"→skill_check(格斗)、"侦查"→skill_check(侦查)→grant_clue(铜钥匙)、"撬锁"→skill_check(机械维修)；
- **工具续接调用** → 按上轮工具结果推下一步（combat skill 检定成功→roll_dice→adjust_hp），让客户端 8 轮工具循环被端到端真实走一遍；
- force-tools → 每个请求的工具名一个 toolCall；
- 流式 → 叙事拆两段 chunk，顺带验证 WS 流式路径；
- listModels → 固定 `mock-model`。

契约保证：**MOCK 模式图拓扑与真实模式完全一致**（有单测证明），因此 H5 E2E / CI 可以零配置全链路跑通。

---

## 九、前端核心：gameStore 与工具执行链

### 9.1 gameStore（`client/src/stores/gameStore.ts`，857 行）——客户端状态真源

**游戏阶段机**：`story_selected → occupation_selected → playing → ended`（`useGameGuard` 守卫）。

**每轮玩家消息主链路**（`sendPlayerMessage`）：

```
① 组装 chatMessages（最近 18 条对话 + 长期摘要 + 记忆点 + 角色卡 + RAG 上下文）
   —— kpPromptService：BASE_INSTRUCTIONS（KP 身份/防剧透/严禁文字编骰/战斗链/三线索冗余/孤注一掷细则…
      共约 40 条 COC 7th 守则）+ buildCharacterContext + buildMemoryBlock(≤30) +
      buildRecentTurnsBlock(最近5轮每轮120字) + longTermSummary + ragContext
② runKpAgentLoop（kpSessionService，见 9.2）→ 工具循环
③ 记忆提取：extractMemoryPoints（LLM 抽 3-5 条 ≤40 字要点）→ kpMemory（上限 30）
④ 长程摘要触发：场景切换 / 每 N 回合（自适应：<20 回合每 5、≥20 每 3、≥40 每 2）/
   高影响工具回合（grant_clue/melee_attack/ranged_attack/san_check/trigger_insanity）
   → runLongTermSummarization：RAG 检索 + 会话图摘要 + LLM 合并，收缩率 <85% 才落地（防劣化），fire-and-forget
⑤ narrativeStall 计数：_turnHadProgressTool ? 0 : min(10, +1)
⑥ traceBus 全程打点（prompt_assembly / kp_agent_loop_iteration / state_update / long_term_summary…）
```

**关键状态与动作**：

- `cluesObtained` 结构化 `{id, description}`（旧存档纯字符串自动迁移）；
- `transitionToScene`：记 `scenesVisited` + 上报会话图 + 触发摘要；
- `updateCharacterHP`：HP≤0 → 自动 `endGame('defeat')`；
- `updateCharacterSAN`：SAN≤0 → **先置 insanityState='permanent' 再 endGame**（修复了原来只 endGame 状态不一致的 bug）；
- `updateCharacterInsanityState`：设置疯狂状态 + 恐惧症/躁狂症；
- `endGame`：冻结 endingState（outcome/title/summary/epilogueOptions/keyFacts/finalSnapshot/clues/scenes）+ 跳结局页；
- `sanitizeKpResponse`：把 LLM 泄漏的内部指引（`[意图提示]`/`[工具说明]`/`## 内部指引`…）从流式预览里洗掉；
- `buildStoryContext`：拼 `{scriptId, openClues, sceneId/sceneName, sanity:{currentSan, dailySanLoss}, forceTransitionScene}` 每轮随 invoke 上传；
- 存档 `saveGame` → `writeSaveSnapshot`（全量快照含角色卡）；`loadGame` 按 `SAVE_VERSION` 分新旧档恢复（版本不符则丢弃摘要类字段）。

### 9.2 工具循环（`client/src/services/kpSessionService.ts`）

```
runKpAgentLoop（≤8 轮）：
  kpInvokeOnce（优先 WS 流式 kp:invokeStream，无 WS 回退 REST kpInvoke）
    → chunk 流式拼 preview 更新 UI（base + '\n\n' + iter）
    → end 帧 {content, toolCalls}
  → 有 toolCalls → processToolCalls（orchestrator 执行）
  → insertMessagesBeforeLast（骰子/系统展示消息插到流式消息前）
  → msgs 追加 assistant(tool_calls) + tool 结果（summarizeToolResult 摘要头 + 600 字符截断）
  → 下一轮
单轮失败 → trace_error + break（保留已产出叙事，不烧剩余重试）
```

**性能保护**（perf A4）：工具结果回传时先加 `【结果摘要】` 头部（前 6 个字段各 40 字符），再截断 600 字符——长工具链历史不再无限膨胀。服务端 `parseToolResultContent` 从第一个 `{` 起解析，兼容摘要头。

### 9.3 工具执行（`client/src/toolCalling/`）

**orchestrator**：JSON.parse 参数 → `NAME_TO_HANDLER` 路由 → 异常捕获返回 `error: 原因`（**回喂 LLM 让其自纠**，而不是中断流程）→ 逐条 trace `tool_executed`。DEV 模式校验 shared 18 工具都有 handler。

**6 个 handler 的规则实现**（COC 7th 规则书合规的核心）：

| Handler | 工具 | 规则要点 |
|---|---|---|
| checkHandler | skill_check / opposed_check / roll_dice | d100 vs 技能值；regular/hard/extreme（÷1/2/5）；奖惩骰（0-2，十位数取高/低，互消）；大失败 96+/100（技能<50 时）；孤注一掷 isPush；对抗等级链 critical > extreme > hard > regular > failure > fumble，同级比技能值 |
| combatHandler | melee_attack / ranged_attack / adjust_hp / apply_major_wound / first_aid / medicine | 命中→伤害骰+伤害加值DB−护甲；**贯穿武器极难成功伤害取满+额外再骰一份**；重伤（≥半HP，CON 检定昏迷）/濒死/即死；急救稳定 1HP；医学 1D3 |
| sanityHandler | san_check / trigger_insanity / adjust_san / reset_day | 大失败 SAN 损失取最大骰；**疯狂三级判定**：SAN≤0 永久 / 当日累计 ≥⌊SAN/5⌋ 不定性 / 单次损失 ≥5 → INT 检定（成功临时失败压抑）；1D10 发作表（9=恐惧症、10=躁狂症，从 `insanityTables.ts` 表抽取）；克苏鲁神话值下调 SAN 上限（99−mythos）；reset_day 重置当日损失 |
| resourceHandler | adjust_mp / spend_luck | 幸运 1:1 改骰（不可用于幸运/SAN/伤害骰）；MP 增减 |
| narrativeHandler | transition_scene / grant_clue / end_game | 场景切换（防重复入栈）、线索授予（去重、可选 clueId）、结局快照 |
| rulesHandler | 剩余规则扩展 | 见 `rulesHandler.ts` |

`toolContextFactory` 把 gameStore 的角色更新器 + 规则纯函数（parseDiceExpr/rollDamageBonus/奖惩骰）组装成 `ToolHandlerContext` 注入 handler——**规则纯逻辑与 UI 状态解耦**，这也是 `logic/` 纯函数层（coc7Rules 等，137 个用例零改动复用）的设计。

---

## 十、平台抽象层 Bridge 与 WebSocket

### 10.1 PlatformBridge（`client/src/platform/bridge.ts`）

用 `uni.request / uni.uploadFile / uni.connectSocket` 一套实现三端（H5 / mp-weixin / app），实现 shared `Bridge` 接口（约 40 个方法，1:1 对应 api-contract 端点）：

- token 存 `aikp_token`（uni storage），每请求带 `Authorization: Bearer`；
- **401 统一处理**：除 login/register（401=凭据错误）外，清 token + `emitUnauthorized` 事件，页面层决定跳转；
- `kpInvokeStream`：惰性开共享 WS，生成 streamId，订阅帧后 fan-out 给所有 `onKpStream` 监听（调用方按 streamId 过滤）；
- 上传走 `uni.uploadFile`（multipart 字段 `file`）；
- `BridgeError`：统一错误类型（只带 message，不含栈）。

### 10.2 WSService（`client/src/platform/ws.ts`）

- 单连接多流（streamId 复用一条 WS）；
- 指数退避重连（1s→30s）+ 30s 心跳；
- 帧路由 chunk/end/error/trace；error 后忽略同流后续帧（防超时竞态）。

### 10.3 服务端 WS（`server/src/ws/index.ts`）

- `ws://host/ws?token=<JWT>`，无效关 4001；心跳 ping→pong；
- 客户端 `kp:invoke {streamId, messages, storyContext?}` → 服务端跑图 → 推 `chunk/trace/end/error`（同 streamId，一连接多流并发独立）；
- `rag:progress` 服务端→客户端推送（索引进度，按 userId 注册表）；
- 双保险错误兜底：`invokeKpStream` 内部 catch + `handleKpInvoke` 外层 catch，任何异常转 error 帧，绝不抛出到 socket handler。

---

## 十一、数据模型与持久化

`server/src/db/index.ts`：`node:sqlite` `DatabaseSync` 单例，懒建 7 张表（幂等）：

| 表 | 用途 |
|---|---|
| `users` | id / username(unique) / password_hash(bcrypt) / created_at |
| `settings` | user_id 主键 + data(JSON 文档：ai 配置含加密 apiKey + rag 开关 + debugMode) |
| `saves` | (user_id, save_id) + data(JSON 全量快照) + updated_at |
| `scripts` | 剧本库（schema 遗留，当前路由为死代码，见 §16） |
| `stories` | 故事元数据（schema 遗留，实际文件落盘） |
| `rag_index` | 向量索引 JSON 文档（实际按文件落盘 `RAG_DATA_DIR`，此表为索引记录） |
| `user_graphs` | 玩家会话图 JSON（clue/scene/action 事件） |

**存储约定**：DB 存元数据与 JSON 文档；故事/剧本实体文件按 `UPLOADS_DIR/<userId>/stories|scripts/` 落盘（`pathSafety` 防护）。

---

## 十二、安全设计

| 层 | 实现 | 文件 |
|---|---|---|
| 认证 | JWT（30 天）+ bcrypt（cost 10）；WS `?token=` 校验，无效关 4001 | `middleware/auth.ts` |
| API Key | AES-256-GCM 加密落库（密钥 = `sha256(JWT_SECRET)`），GET 设置不回传 | `utils/crypto.ts` + `settingsService` |
| SSRF | `assertSafeOutboundUrl`：仅 http/https，拒绝 localhost/回环/私网/保留地址/IPv6 回环；**所有出站 AI 请求 + listModels fetch 前必经** | `utils/outboundUrl.ts` |
| 路径安全 | `assertId` 消毒 + realpath 防符号链接逃逸 + 按 userId 隔离目录；上传/读取一律经 `pathSafety.ts` | `utils/pathSafety.ts` + `fsSafe.ts` |
| 输入校验 | kp:invoke 消息严格校验（非数组 400、结构校验、坏 arguments JSON 降级 `'{}'`）；temperature/maxTokens 数值校验 | `kpAgentService.normalizeMessages` + `aiService.validateMessages` |
| 错误不泄栈 | 统一 `{error}` JSON，未知错误 500 通用文案；错误码映射 BadRequest 400 / Unauthorized 401 / NotFound 404 / Conflict 409 / Upstream 502 | `utils/errors.ts` + `app.ts` |
| 工具参数 | 客户端 handler 对参数做数值钳制（clamp 0-99 等），越界不崩 | `toolCalling/handlers/*` |

---

## 十三、Agent 工作流调优：从问题到修复

这一节是项目的"成长史"——`test-agent/REPORT.md` 记录的 7 个改进点与修复闭环，理解它们就理解了这套确定性护栏为什么长成这样。

### 13.1 实测暴露的问题（真实 LLM，mimo-v2.5）

**调查链（12 用例）**：
- 场景探索/NPC 对话/场景切换/SAN 检定全部正常 ✅；
- **致命弱点：grant_clue 触发率极低**——12 轮只授 1 次线索。mimo-v2.5 在"调查→发线索"衔接上偏保守，倾向只调 skill_check 不给线索；
- 弱结局表达（"破坏仪式"）未触发 end_game——LLM 未识别结局意图。

**战斗链（5 用例）**：工具链完整（san_check→roll_dice→adjust_san→adjust_hp），但长链轮次耗时 50-106s。

**鲁棒性（8 用例）**：发现坏 arguments JSON 会在 forceTools 重试路径把上游 LLM 打成 400（AW-R-09）；非数组 messages 静默返回空 200（AW-R-01）。

### 13.2 修复方案（对应提交 e2c522a）

| # | 改进点 | 修复 |
|---|---|---|
| 1 | grant_clue 触发率低 | **停滞检测重写**（`computeStallLevelFromHistory`）：原来每 invoke 新图实例导致 stallLevel 永远从 0 开始、且 planTools 在 generate 前看不到本轮 toolCalls → 改为从对话历史推导：连续无进展回合（仅 skill_check 不重置）≥2 强制 grant_clue、≥4 强制 transition_scene |
| 2 | SAN 疯狂依赖客户端上报 | 客户端不再发 storyContext.sanity → 服务端从历史 san_check 结果推导（`extractSanStateFromHistory`），≥5 或 ≥1/5 强制 trigger_insanity（`shouldTriggerInsanity` 阈值与客户端 sanityHandler 对齐） |
| 3 | 结局弱表达 | 新增 `ENDGAME_PATTERNS` 强意图正则短路（刻意收窄词表防误伤"离开房间"）+ planTools 强制 end_game |
| 4 | 工具续接遗漏 | `analyzeToolContinuation` 前向推导 follow-up 工具（combat skill 成功→roll_dice；roll_dice 结果→adjust_hp）+ 【工具续接】提示注入，防漏步/防重复 |
| 5 | 长对话劣化 | 工具结果回传 600 字符截断 + `【结果摘要】` 头（120 字符）；摘要间隔自适应（20/40 回合后缩短）；单轮失败 break 不烧重试 |
| 6 | 性能 | 意图分类规则短路（`INTENT_RULES_ORDER`）跳过分类 LLM；图实例 10s TTL 缓存；流式路径永不缓存 |
| 7 | 鲁棒性 | normalizeMessages 全结构校验（非数组/坏结构 400）+ arguments JSON 降级 `'{}'`；forceTools 历史 tool_calls 规范化 |

**回归结果**：全部 7 项闭环；新增门控回归 7/7 通过（含"缺前置线索时禁止切场景"、"探索轮注入可授线索清单"等）。

---

## 十四、测试体系

四层测试金字塔 + 一个独立测试套件：

```
① 单元测试（vitest）
   server 220 用例：路由（auth/ai/settings/rag/saves/scripts/stories + 上传限额）、
   kpGraph 状态机（含 fixes）、scriptContext 门控、mockAi、aiService 超时、ws 流式、RAG 各件
   client：logic 纯函数（137 用例零改动复用）、toolCalling handlers、store 集成（mock bridge）、
   bridge/ws 平台层
   → npm run test:server / test:client / test:all

② H5 端到端（playwright-core + MOCK_AI，无需真实 LLM、不下载浏览器）
   e2e/h5.journey.mjs：自动起后端(3100) + H5 dev(5175) → 注册登录 → 设置 → 导入剧本 → RAG 索引 →
   选职业 → 创角色（投骰+兴趣技能+姓名）→ 开场 → 侦查消息（skill_check→grant_clue，线索+1）→
   战斗消息（skill_check→roll_dice→adjust_hp，HP−2）→ 存档 → 读档 → 恢复断言 → 截图
   → npm run test:e2e:h5（CI 中运行）

③ Agent 工作流测试（test-agent/，真实 LLM，独立套件不改项目代码）
   smoke / scenario-investigate(12) / scenario-combat(5) / scenario-sanity(5) / scenario-save(6) /
   scenario-gating(7) / robustness(8) / performance(5) = 36 用例 + 门控回归 7 = 43 全过
   需 OpenAI 兼容端点（自动读本机 ZCode opencode/mimo-v2.5 配置或 AW_* 环境变量）
   → 报告在 test-agent/REPORT.md，性能数据在 perf-results.json

④ 设备端验证（文档记录在 bb29e30）
   - 微信小程序：miniprogram-automator 连开发者工具（需管理员启动 + 服务端口开启），7/7 断言通过
     （首页渲染→按钮→设置页→返回）；踩坑：Tool.getInfo 结构变化需 patch-automator 修补
   - Android 模拟器：Pixel 5 / Android 14 加载 H5 构建，首页渲染 + 后端可达（10.0.2.2）

⑤ CI（.github/workflows/ci.yml）：push/PR 到 main → npm ci → server 单测 → client 单测 → 构建 → e2e H5
   发布（release.yml）：tag v* → 构建产物上传 GitHub Release（幂等：release 已存在时补传资产）
```

---

## 十五、性能特征与已知瓶颈

实测数据（`test-agent/perf-results.json`，mimo-v2.5）：

| 指标 | 数值 | 说明 |
|---|---|---|
| 单轮普通叙事 | ~9-14s | 几乎全部为 LLM 推理时间（AW-P-01/03） |
| 单工具链轮次 | ~12s / 2 轮 | skill_check 链（AW-P-02） |
| 多工具链长轮次 | 60-106s | 链长 × 推理时间线性放大（战斗链最坏） |
| trace 事件 | 每次 invoke 恰好 6 个 | 供调试/断言 |

**瓶颈本质**：LLM 推理主导，且工具循环在客户端 = 每轮工具链多次 HTTP/WS 往返 + 多次 LLM 调用。已做缓解：意图规则短路、图缓存、工具结果截断、摘要自适应、失败快速退出。**架构性约束**：长对话上下文反复上传、服务端无会话缓存——完整方案（服务端会话缓存/历史压缩）在待办（§16）。

---

## 十六、遗留项与技术债

| 类别 | 项 | 现状/建议 |
|---|---|---|
| 🔴 性能 | 长工具链 60-106s；长对话劣化 | 已缓解（§13），完整方案待专项：服务端会话缓存、历史压缩 |
| 🟡 确定性 | 弱结局表达（如"破坏仪式"）仍依赖 LLM 自觉 | 已修强意图词；可考虑「门控场景完结时服务端强制 end_game」 |
| 🟡 协议 | storyContext 为可选字段，旧客户端不传则门控不生效 | 已标注；升级客户端即生效 |
| 🟢 遗留 | `scripts` 路由/桥接为死代码（无调用方）；`stories`/`scripts` DB 表未使用 | 清理或按需启用（剧本库） |
| 🟢 遗留 | 自由文本 obtainCondition/transitionCondition 无语义解析（维持双轨） | 结构化优先策略，有意为之 |
| 🟢 遗留 | 无 DB 迁移机制（幂等建表） | 结构变更需手动处理，建议引入版本号 |
| 🟢 测试 | test-agent 真实 LLM 用例偶发超时（120s step 上限） | 已放宽 240s；CI 不跑 test-agent（需 API Key） |

---

## 十七、新手指南：从哪里开始读代码

**建议阅读顺序**（由外到内，每层都先读注释头再读实现）：

1. **README.md** —— 全项目运行手册（30 分钟）；
2. **docs/api-contract.md** —— 前后端唯一接口基准，所有端点/帧/错误码的定义；
3. **shared/tools/cocTools.ts** —— 18 个工具的 schema（读完你就知道 KP 能做什么）；
4. **server/src/agent/kpGraph.ts** —— 状态机（最难但最重要，配合 §5 逐节点读）；
5. **server/src/services/kpAgentService.ts** —— 图如何被注入与调用（超时/缓存/校验）；
6. **server/src/agent/scriptContext.ts** —— 门控判定；
7. **server/src/services/aiService.ts** —— 三协议适配器 + SSRF + 超时；
8. **server/src/services/mockAi.ts** —— 确定性脚本（理解测试如何不依赖 LLM）；
9. **client/src/stores/gameStore.ts** —— 客户端真源（配合 §9.1）；
10. **client/src/services/kpSessionService.ts** —— 工具循环；
11. **client/src/toolCalling/orchestrator.ts + handlers/** —— 规则执行；
12. **client/src/platform/bridge.ts + ws.ts** —— 三端抽象；
13. **e2e/h5.journey.mjs** —— 一次完整旅程的自动化视角；
14. **test-agent/REPORT.md** —— 真实 LLM 下系统如何表现、修过什么。

**动手建议**：
- 改后端前先跑 `npm run test:server` 建立基线（220 用例）；
- 改前端逻辑前跑 `npm run test:client` + `npx tsc --noEmit`（零错误基线）；
- 本地体验全流程：`MOCK_AI=1 npm run dev:server` + `npm run dev:h5`（零配置，无需 API Key）；
- 需要真实 LLM 验证时：`cd test-agent && node run-all.mjs`（需配置 AW_* 环境变量）；
- **不要修改 `original/`**（只读参考）；**新工具定义必须加在 `shared/tools/cocTools.ts` 并同步 handler**（DEV 模式会警告）。
