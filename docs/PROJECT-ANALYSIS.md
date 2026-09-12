# AI-COC-KP 项目分析（代码 · 模块 · 逻辑）

> 版本：0.1.0 · 分析日期：2026-08-18 · 配套文档：`README.md`（运行/测试）、`docs/api-contract.md`（接口契约）、`docs/MIGRATION-PLAN.md`（重构计划）
>
> 本分析基于对全部源码的通读 + `test-agent/REPORT.md` 的实测结论（36 用例 + 门控回归 7 用例）。
> **2026-09-13 更新**：模块地图 / RAG / WS / 前端详解 / 数据流各节已按 **ADR-0002 之后的现行架构**（服务端权威单轨）改写；原文描述的是 ADR-0002 之前的客户端权威旧架构，旧形态仅存于本文件 git 历史与 `docs/ARCHITECTURE-MULTIPLAYER.md` / `docs/MIGRATION-PLAN.md` 的史实章节。

---

## 一、项目概览

**定位**：COC 7th 规则 AI 跑团助手——玩家导入剧本，与 AI 守秘人（KP）文字互动，KP 以 LangGraph 状态机 + 24 个规则工具（另有 4 个档案查证工具按需挂载）驱动剧情（探索/战斗/SAN 检定/线索/结局），知识供给走档案 + 检索补充双轨（ADR-0007），配存档读档。

**形态**：npm workspaces monorepo（`server` / `client` / `shared`），H5 + 微信小程序 + App 三端（uni-app），后端 Express + TypeScript + node:sqlite（Node ≥24，零原生依赖）。

**技术栈速览**：

| 层 | 技术 |
|---|---|
| 后端 | Express 5、ws、jsonwebtoken + bcryptjs、openai SDK、@langchain/langgraph、node:sqlite、multer |
| AI 协议 | 四协议一等公民（ADR-0003）：openai_chat / openai_responses / anthropic_messages / google_compatible + MOCK_AI 确定性脚本 |
| 知识供给 | 档案（dossier）为事实权威 + 标准检索补充（递归切块 → TF-IDF/稠密混合召回 → 本地 cross-encoder rerank，ADR-0007；GraphRAG 已删除）、tesseract.js PDF OCR |
| 前端 | uni-app Vue 3、Pinia、vue-i18n、vite 5 |
| 测试 | vitest（server 804+1skip / client 107 / training 50）、playwright-core（e2e 旅程）、miniprogram-automator（小程序）、test-agent 真实 LLM 套件 |

---

## 二、目录与模块地图

```
AI-COC-KP/
├── server/src/
│   ├── app.ts              # Express 工厂 + 引导（路由挂载 → HTTP 监听 → WS 挂载 → 懒建 DB）
│   ├── config.ts           # 环境变量（PORT/JWT_SECRET/MOCK_AI/DATA_DIR/KP_CHUNK_STREAM/…）
│   ├── agent/              # ★ KP 状态机与门控（核心智能）
│   │   ├── kpGraph.ts      #   LangGraph：analyzeInput→routeByIntent→5×Plan/Generate→validate→forceTools
│   │   └── scriptContext.ts#   剧本结构化加载 + 线索门控（requiredClues 判定）
│   ├── rule-engine/        # ★ COC 工具服务端执行（orchestrator + 6 handlers + toolContextFactory）
│   ├── routes/             # 11 组路由：auth/settings/ai/stories/scripts/saves/rag/dossier/rooms/roomSettings/characters
│   ├── services/           # roomService/roomStorage/roomStateCodec/startGate/kpTurnService/kpAgentService/kpPromptService/turnKnowledge/roomMemory/wireSampleService/aiService+llm（4 适配器）/settings/save/story/script/mockAi
│   ├── rag/                # chunker/embedding/reranker/supplementService/supplementAssembly/sceneAttribution/queryBuild/storyParsers/dossier/
│   ├── db/index.ts         # node:sqlite 单例 + 10 张表
│   ├── middleware/auth.ts  # JWT 签发/校验 + requireAuth
│   ├── ws/                 # index（鉴权+帧分派）/ rooms（编解码 adapter）/ roomLedger（订阅簿+帧规划）/ progress（rag:progress）
│   └── utils/              # errors/logging/crypto/outboundUrl(SSRF)/pathSafety/fileNames/fsSafe
├── client/src/
│   ├── pages/              # home/scripts/settings/rag-inspector(H5 only)/game(+game-end + rooms)/character(occupation 三步建卡)
│   ├── stores/             # roomStore（RoomClient 视图模型）/settingsStore/storyStore —— 零领域状态
│   ├── services/           # ai/（设置/模型列表）+ ragService（索引/查询）
│   ├── platform/           # bridge（三端适配 + 房间帧收发）/ws（单连接房间帧路由+重连）/config/token
│   └── composables/        # useToast
├── shared/
│   ├── coc/                # 规则纯函数：coc7Rules/diceService/insanityTables/coc7Character 等（旧 client logic/、data/ 上收于此）
│   ├── types/              # bridge/room/storyContext/ending/game/character/script/settings
│   ├── tools/cocTools.ts   # 24 个工具 schema 单一来源 + kpValidation（校验规则单源）/ storyLookupTools（档案查证工具）
│   └── constants/providers.ts # LLM 协议清单（4 协议，ADR-0003）
├── e2e/  test-agent/  training/（KP 自训工作区，ADR-0006）  tools/mp-test/  docs/  original/（只读参考）
```

---

## 三、后端逻辑详解

### 3.1 启动与数据层

- `app.ts`：`createApp()` 挂 `cors` + `express.json({limit:'1mb'})` → 11 组路由（auth/settings/ai/stories/scripts/saves/rag/dossier/rooms/roomSettings/characters）→ 404 兜底 → 全局错误处理（4xx 保留状态、其余 500 不泄栈）。直跑时 `listen(PORT)` 后 `createWsServer(httpServer)`。
- `db/index.ts`：`node:sqlite` `DatabaseSync` 单例，首次请求时懒建 10 张表——`users` / `settings`（JSON 文档）/ `saves` / `scripts` / `stories` / `rag_index` / `rooms`（房间 DB 权威，含 `state` JSON 快照与 `kind`/`phase` 列）/ `characters`（角色卡）/ `room_members`（成员资格 + 绑卡）/ `kp_wire_samples`（wire 采样日志）。无迁移机制（幂等 CREATE IF NOT EXISTS）。
- 存储约定：**数据库存元数据与 JSON 文档，文件存故事/剧本实体**（`UPLOADS_DIR/<userId>/stories|scripts/`）；`scripts` 表为 schema 遗留（实际文件落盘）。

### 3.2 认证与设置

- `authService`：注册（用户名 3-32、密码 ≥6、bcrypt cost 10）、登录、`GET /me`；JWT 30 天。
- `settingsService`：`ai` 配置（protocol/baseUrl/model/temperature/maxTokens/apiKey，ADR-0003 协议一等公民）+ `rag` 开关；**apiKey AES-256-GCM 加密落库**（密钥 = `sha256(JWT_SECRET)`），GET 省略；`validatePatch` 校验 protocol 白名单/temperature 0-2/maxTokens 1-1000000。

### 3.3 KP Agent 状态机（智能核心）— `agent/kpGraph.ts`

**图拓扑**（`createKPGraph`）：

```
START → analyzeInput → routeByIntent ─(条件边)→ {generic|combat|sanity|narrative|resource}Plan
      → Generate → validate ─(条件边)→ END | forceTools → validate（max 1 次重试）
```

**节点职责**：

| 节点 | 类型 | 逻辑 |
|---|---|---|
| `analyzeInput` | LLM+程序化 | ① 尾部连续 tool 消息 → 短路 `tool_continuation`（跳过分类 LLM）；② 结局强意图正则（结束冒险/团灭/成功逃离/真相大白…）→ 短路 `endgame`；③ 历史 SAN 损失 ≥5 或累计 ≥1/5 当前 SAN（`extractSanStateFromHistory`）→ 短路 `san_encounter`；④ 否则 LLM 分类（9 意图，maxTokens 32 无工具） |
| `routeByIntent` | 纯程序化 | combat→combat；san_encounter→sanity；investigate/explore/talk_npc/move/tool_continuation/narrative/endgame→narrative；use_item→resource；其余→generic |
| `PlanTools` | 纯程序化 | 每意图 `required` 清单 + 停滞强制（历史无进展计数 ≥2 强制 `grant_clue`、≥4 强制 `transition_scene`）+ SAN 历史强制 `trigger_insanity` + endgame 强制 `end_game` + **线索门控**（见 3.4）+ generic 护栏（剔除高影响叙事工具） |
| `Generate` | LLM | 拼 hintBlock（守则/必调工具/故事上下文/门控提示）→ 一次调用，返回 content + toolCalls |
| `validate` | 纯程序化 | 缺 required 工具（`TOOL_EQUIVALENTS` 展开 melee/ranged_attack）+ 文本模拟检测（正则：`d100: 45`、`HP 降至`…）→ 清理后进 forceTools；重试 ≥1 则 `max_retries` 放行 |
| `forceTools` | LLM | 工具专用提示词重发（历史 tool_calls 规范化防坏 JSON），成功合并 toolCalls |

**性能特征**（真实 LLM 实测，`test-agent/REPORT.md`，e2c522a 时代数据）：每次 invoke 恰好 6 个 trace 事件（intent_classified / agent_routed / tool_plan_created / llm_generate_start / llm_generate_end / validation_result）；单轮 10-15s（几乎全为 LLM 推理）；多工具链轮次 60-106s（工具链长度 × 推理时间线性放大）；120s 图超时兜底（`kpAgentService`）。

### 3.4 线索门控 — `agent/scriptContext.ts`

- **双轨设计**：剧本 JSON 含结构化 `clues[].requiredClues` / `scenes[].requiredClues` → 程序化判定；只有自由文本 `obtainCondition`/`transitionCondition`（原仓库剧本）→ 注入参考文本，**不拦截**（零回归）。
- **判定函数**：`findScene`（id/名称/文本子串，最长名匹配防歧义）、`sceneUnlocked`（返回 `true|false|null` + 缺失线索）、`getAvailableClues`（场景内未获且前置满足的线索清单）、`getSceneNpcs`。
- **注入点**（planTools Phase 3.5，narrative agent）：玩家文本提到非当前场景的已知场景 → 锁闭则提示缺失线索并**移除 required 中的 transition_scene**（防硬切）、解锁则提示可切换；探索意图 → 注入本场景可获线索清单（配合停滞强制解决"只检定不给线索"）。
- **数据来源**：服务端自持（ADR-0002，客户端不上传任何状态）——`RoomService.flushTurn` 以房主账号解析剧本，storyContext（scriptId/openClues/sceneName）来自房间运行时状态与 session 角色快照；60s TTL 缓存，加载失败静默降级。

### 3.5 知识供给（`rag/`，ADR-0007 双轨）

- **档案（dossier）= 事实权威**（`rag/dossier/`）：生成期 LLM 从剧本原文抽取场景/线索/NPC/真相/结局落盘（`dossierGenerate.ts`，质量门低覆盖 409 拒开局）；查询期 `dossierCore.ts` 按当前场景整块渲染注入；`verify_original` 原文查证按场景锚点窗口取原文（≤12k 字符）交子阅读器作答，降级不阻断回合；scene_list/scene_dossier/lexical_search/verify_original 4 个查证工具由 TurnKnowledge workflow 门决定是否挂载。
- **检索补充 = 纹理层**（`vectorStore` + `supplementService`/`supplementAssembly`）：服务端递归切块（`chunker.ts`，~800 字符/重叠 100，块只存字符偏移）→ TF-IDF + 稠密混合召回 top10 → 本地 cross-encoder rerank（`reranker.ts`，缺失降级纯余弦）→ top3 以独立小节「原文片段（检索补充·仅作描写素材）」注入；跨场景块 ≤1 条并标注，与 `truths[].revealScene` 锚点相交直接丢弃（剧透硬闸）；场景归属查询期用 `coverageGaps` 场景锚点现算（`sceneAttribution.ts`）。
- **GraphRAG 已按 ADR-0007 决策 3 删除**（图代码/图提示词/图设置项与图端点全部移除，档案取代「关系情报块」角色）。
- **文档解析**（`storyParsers`）：mammoth(docx)/epub2(epub)/jsdom(html)/pdf-parse+pdf-lib+tesseract.js OCR(pdf)。
- **embedding 双通道**：内置 transformers.js（text2vec-base-chinese-sentence，模型缓存 MODELS_DIR）优先，失败回退 OpenAI 兼容 `/v1/embeddings`。

### 3.6 WS 协议（`ws/`）

- 认证：`ws://host/ws?token=<JWT>`，无效关闭 **4001**；心跳 `ping→pong`。
- 帧：客户端仅 `room:join` / `room:leave` / `room:sync` / `room:action` 4 种（编解码 adapter 在 `ws/rooms.ts`，订阅注册与帧规划在 `ws/roomLedger.ts`，缺口过大全量兜底）；服务端 → 客户端推 `room:state`（全量快照）/ `room:event`（seq 全序增量）/ `room:sync:done` / `room:error`（ADR-0002）。`kp:` 前缀帧已全部退役。
- `rag:progress` 服务端→客户端推送（RAG 索引进度，userId→Socket 注册表）；未知客户端帧类型忽略。

### 3.7 防御性设计（安全/鲁棒性）

- **输入校验**（`kpTurnService.runKpTurn` → `kpAgentService.normalizeMessages`）：非数组 → 400；缺 role/content → 400；assistant `tool_calls` 结构校验（id/name/arguments 非 string → 400）；**坏 arguments JSON 降级 `'{}'`**（不 500，对齐 rule-engine 逐工具错误处理）；tool 消息缺 tool_call_id → 400。
- **出站安全**（`outboundUrl`）：仅 http/https，拒绝 localhost/回环/私网/保留地址/IPv6 回环（SSRF）。
- **路径安全**（`pathSafety`）：`assertId` + realpath 防符号链接逃逸 + 按 userId 隔离目录。
- **错误映射**（`utils/errors`）：BadRequest 400 / Unauthorized 401 / NotFound 404 / Conflict 409 / Upstream 502，未知错误 500 通用文案。
- **WS 错误兜底**：各 handle* 分派器内部捕获异常并以 `room:error` 帧回推；socket 级 `error`/`close` 统一清理 progress 注册表与房间订阅，异常绝不抛出到 socket handler。

---

## 四、前端（RoomClient）与服务端回合链路（ADR-0002 现行）

### 4.1 RoomClient（`client/src/stores/roomStore.ts`）——客户端唯一的房间视图模型

本 store **不产生任何房间状态**，状态真源是服务端 RoomService（每房间单实例，seq 全序广播）。RoomClient 只做三件事：

```
① 订阅 room:event 增量，按 seq 顺序应用到本地视图模型（消息/角色组/线索/场景/结局）；
② 首次加入或断线重连缺口过大时，接收 room:state 全量快照，整体替换本地状态；
③ 把页面动作发往服务端——治理动作（建房/邀请码加入/绑卡/开局/就绪…）走 REST
   （RoomService 领域方法，ADR-0001），回合发言走 WS room:action{type:'chat'}；
   trace 帧随事件消费（调试观测）。
```

**唯一乐观面 = 自己发出的消息**（本地 `pending` → 服务端 `message_appended` 回灌后移除）；生命周期 `joinRoom` 幂等（idle→joining→joined），被移出（kicked）/解散（dissolved）有成员资格自检。页面不持有领域状态、不组装提示词、不拉取 RAG（ADR-0002 决策 5）。

### 4.2 服务端回合链路（`roomService.flushTurn` → `kpTurnService.runKpTurn`）

```
① 上下文组装（服务端收口，客户端零参与）：kpPromptService.buildRoomTurnMessages——
   BASE_INSTRUCTIONS 守则 + 角色花名册注入 + 记忆要点块（≤30）+ 近轮对话窗；
   知识块由 TurnKnowledge 装配（档案场景块 / 标准检索情报块 + 补充层，见 §3.5）
② kpTurnService.runKpTurn：服务端图内工具循环（≤8 轮），LLM 调用与工具执行同进程
   完成，不再经网络往返；工具结果回传先加摘要头再截断 600 字符（防长链膨胀）
③ 回合产物落房间状态并广播 room:event：KP 叙事整段 message_appended（ADR-0002 否决
   kp:chunk 流式帧）、骰子 dice_result、调试 trace、状态增量 state_patch；变更节流落库
   rooms.state 快照（重进房间 = 续玩）
④ 记忆编排同在服务端（roomMemory）：抽取 3-5 条 ≤40 字要点 + 摘要收缩，
   失败回退（抽取失败→截断兜底，摘要失败→保持原摘要）
```

多人房可经 `turnWindowMs` 合并窗口（房主可调，0 = 严格排队；solo 恒为 0）；**单人 = 单成员房间**（`kind='solo'`，出生即 playing，与多人共用同一 wire 协议）。

### 4.3 工具执行链（`server/src/rule-engine/`，服务端）

- **orchestrator**：`processToolCalls` — JSON.parse 参数 → `NAME_TO_HANDLER` 路由 → 异常捕获返回 `error:` 前缀（回喂 LLM 让模型自纠）→ 逐条 trace `tool_executed`；DEV 模式校验工具与 handler 覆盖一致（缺 handler 打 warn）。
- **6 个 handler**（规则实现详表见 ONBOARDING-GUIDE §9.3）：checkHandler（d100/等级链/奖惩骰/大失败）、combatHandler（伤害加值/贯穿武器/重伤濒死即死/急救医学）、sanityHandler（疯狂三级判定/1D10 发作表/神话值上限）、resourceHandler（幸运 1:1 改骰/MP）、narrativeHandler（切场景/授线索/结局快照）、rulesHandler（规则扩展）——COC 7th 规则合规；规则纯函数上收 `shared/coc/` 两端共享。
- **toolContext**（`toolContextFactory` + `characterMutators`）：把 session 角色快照的更新回调组装成 `ToolHandlerContext` 注入 handler——**规则纯逻辑与持久化状态解耦**。

### 4.4 平台适配层（platform）

- `bridge.ts`（PlatformBridge）：用 `uni.request/uploadFile/connectSocket` 统一三端，实现 shared `Bridge` 接口；401 清 token + `onUnauthorized` 事件；`sendRoomFrame`/`onRoomFrame` 收发房间帧（KP 回合只走房间协议）。
- `ws.ts`（WSService）：单连接复用；指数退避重连（1s→30s）+ 30s 心跳，重连成功通知订阅者重新 room:join；帧路由 `room:state/event/sync:done/error` 逐帧转发 roomStore。
- `config.ts`：`VITE_API_BASE` 优先，H5 回退同源 `/api`，小程序/App 无配置快速失败。
- `token.ts`：`aikp_token` uni storage + 401 事件总线。

---

## 五、数据流全景（一次 KP 回合，ADR-0002 现行）

```
玩家 ──> 游戏页 ──> roomStore 发送 WS room:action{type:'chat'}（唯一乐观面：本地 pending）
  ──> 服务端 RoomService：串行队列（多人房经 turnWindowMs 合并窗口）→ flushTurn
  ──> TurnKnowledge 装配知识（dossier 场景档案块 / 标准检索情报块 + 补充层，见 §3.5）
  ──> kpPromptService.buildRoomTurnMessages（守则 + 角色花名册 + 记忆块 + 近轮对话窗）
  ──> kpTurnService.runKpTurn：图内工具循环 ≤8 轮
       （kpGraph：意图分类/短路 → planTools(含门控) → LLM 生成 → validate → forceTools
         → rule-engine processToolCalls 服务端执行工具，同进程无网络往返）
  ──> 回合产物广播 room:event（message_appended / dice_result / trace / state_patch）
  ──> roomStore 按 seq 应用增量 → 叙事落屏；变更节流落库 rooms.state（重进 = 续玩）
  ──> roomMemory 记忆编排（要点抽取 + 摘要收缩，服务端）
```

存/读档：房间快照节流落库（重进即续玩）为默认路径；`/api/saves*` REST 为显式存读档契约（见 `docs/api-contract.md`）。

**状态归属**：角色属性/线索/场景/疯狂状态的唯一真源在**服务端**（RoomService 活跃实例 + DB 节流落库，ADR-0001）；客户端 RoomClient 是纯视图模型，按 seq 应用事件——服务端权威单轨（ADR-0002），防作弊、多端一致、重进即恢复。

---

## 六、风险与遗留项（基于实测）

| 类别 | 问题 | 现状/建议 |
|---|---|---|
| 🔴 性能 | 长工具链轮次耗时（LLM 推理 × 链长） | 已缓解：服务端图内循环（无逐轮网络往返）+ 工具结果 600 字符截断 + 单轮失败退出；服务端记忆编排（roomMemory）+ 近轮对话窗已落地。剩余瓶颈 = LLM 推理 |
| 🟡 确定性 | 结局/线索/疯狂依赖 LLM 自觉的残余场景（如"破坏仪式"弱表达未触发 end_game） | 已修复强意图词；弱表达场景可考虑「门控场景完结时服务端强制 end_game」 |
| 🟢 已消亡 | storyContext 由客户端上传的兼容性问题 | 客户端状态上传入口已随 ADR-0002 整体删除（上下文注入服务端收口） |
| 🟢 遗留 | `scripts` 路由/桥接为死代码（无调用方）；`stories`/`scripts` DB 表未使用 | 清理或按需启用（剧本库） |
| 🟢 遗留 | 自由文本 `obtainCondition`/`transitionCondition` 无语义解析（维持双轨） | 结构化优先策略，有意为之 |
| 🟢 遗留 | 无 DB 迁移机制（幂等建表） | 结构变更需手动处理，建议引入版本号 |
| 🟢 测试 | test-agent 真实 LLM 用例偶发超时（120s step 上限，长链波动） | 已放宽至 240s；CI 不跑 test-agent（需 API Key） |

---

## 七、结论

- **架构**：三包 monorepo 职责清晰（server 权威单轨：RoomService 活跃实例 + kpTurnService 图内工具循环；client 纯视图模型；shared 契约单一来源），协议契约化（api-contract.md），房间事件流是唯一事实源（ADR-0001/0002）。
- **智能**：LangGraph 状态机 + 24 工具（另有 4 个档案查证工具按需挂载）+ 确定性兜底（SAN/结局/停滞/门控）+ 档案权威的知识供给（ADR-0007），已形成"LLM 自由发挥 + 程序化护栏"的稳健组合。
- **安全**：认证、加密、SSRF、路径防护、输入校验五层齐全。
- **主要短板**：性能（LLM 推理主导）；长对话管理已由服务端记忆编排缓解，按 §6 路线继续观察。
