# AI-COC-KP 项目分析（代码 · 模块 · 逻辑）

> 版本：0.1.0 · 分析日期：2026-08-18 · 配套文档：`README.md`（运行/测试）、`docs/api-contract.md`（接口契约）、`docs/MIGRATION-PLAN.md`（重构计划）
>
> 本分析基于对全部源码的通读 + `test-agent/REPORT.md` 的实测结论（36 用例 + 门控回归 7 用例）。

---

## 一、项目概览

**定位**：COC 7th 规则 AI 跑团助手——玩家导入剧本，与 AI 守秘人（KP）文字互动，KP 以 LangGraph 状态机 + 18 个规则工具驱动剧情（探索/战斗/SAN 检定/线索/结局），并配 RAG 检索剧本知识、存档读档。

**形态**：npm workspaces monorepo（`server` / `client` / `shared`），H5 + 微信小程序 + App 三端（uni-app），后端 Express + TypeScript + node:sqlite（Node ≥24，零原生依赖）。

**技术栈速览**：

| 层 | 技术 |
|---|---|
| 后端 | Express 4、ws、jsonwebtoken + bcryptjs、openai SDK、@langchain/langgraph、node:sqlite、multer |
| AI 协议 | OpenAI 兼容 / Anthropic SSE / Google SSE 三适配器 + MOCK_AI 确定性脚本 |
| 检索 | TF-IDF + 稠密向量混合（transformers.js 本地 embedding 或 API）、GraphRAG（LLM 图抽取 + 社区检测）、tesseract.js PDF OCR |
| 前端 | uni-app Vue 3、Pinia、vue-i18n、vite 5 |
| 测试 | vitest（server 220 / client）、playwright-core（H5 e2e）、miniprogram-automator（小程序）、test-agent 真实 LLM 套件 |

---

## 二、目录与模块地图

```
AI-COC-KP/
├── server/src/
│   ├── app.ts              # Express 工厂 + 引导（路由挂载 → HTTP 监听 → WS 挂载 → 懒建 DB）
│   ├── config.ts           # 环境变量（PORT/JWT_SECRET/MOCK_AI/DATA_DIR/…）
│   ├── agent/              # ★ KP 状态机与门控（核心智能）
│   │   ├── kpGraph.ts      #   LangGraph：analyzeInput→routeByIntent→5×Plan/Generate→validate→forceTools
│   │   └── scriptContext.ts#   剧本结构化加载 + 线索门控（requiredClues 判定）
│   ├── routes/             # 8 组路由：auth/settings/ai/kp/stories/scripts/saves/rag
│   ├── services/           # auth/settings/ai/kpAgent/mockAi/save/story/script/rag 服务
│   ├── rag/                # embedding/vectorStore/graphStore/graphExtractLLM/graphRag/userGraphStore/storyParsers
│   ├── db/index.ts         # node:sqlite 单例 + 7 张表
│   ├── middleware/auth.ts  # JWT 签发/校验 + requireAuth
│   ├── ws/                 # /ws（token 认证、kp:invoke 流式、rag:progress 推送）
│   └── utils/              # errors/logging/crypto/outboundUrl(SSRF)/pathSafety/fileNames/fsSafe
├── client/src/
│   ├── pages/              # home/scripts/settings/rag-inspector/game(+game-end)/character(occupation+create)
│   ├── stores/             # gameStore（核心，~825 行）/settingsStore/storyStore/debugStore
│   ├── services/           # kpSessionService（工具循环）/kpPromptService（prompt 组装）/memory*/rag*/ai*/save*
│   ├── toolCalling/        # orchestrator + 5 handlers（18 工具执行）+ types
│   ├── logic/              # coc7Character（角色生成）/coc7Rules（检定公式）/healingRules
│   ├── platform/           # bridge（三端适配）/ws（单连接多流+重连）/config/token
│   └── composables/        # useGameGuard/useToast
├── shared/
│   ├── types/              # bridge/storyContext/ending/game/character/script/settings
│   ├── tools/cocTools.ts   # 18 个工具 schema 单一来源
│   └── constants/providers.ts # provider 清单（6 预设 + 4 自定义）
├── e2e/  test-agent/  tools/mp-test/  docs/  original/（只读参考）
```

---

## 三、后端逻辑详解

### 3.1 启动与数据层

- `app.ts`：`createApp()` 挂 `cors` + `express.json({limit:'1mb'})` → 8 组路由 → 404 兜底 → 全局错误处理（4xx 保留状态、其余 500 不泄栈）。直跑时 `listen(PORT)` 后 `createWsServer(httpServer)`。
- `db/index.ts`：`node:sqlite` `DatabaseSync` 单例，首次请求时懒建 7 张表——`users` / `settings`（JSON 文档）/ `saves` / `scripts` / `stories` / `rag_index` / `user_graphs`。无迁移机制（幂等 CREATE IF NOT EXISTS）。
- 存储约定：**数据库存元数据与 JSON 文档，文件存故事/剧本实体**（`UPLOADS_DIR/<userId>/stories|scripts/`）；`scripts`/`stories` 表为 schema 遗留（实际未用，见 §6 遗留项）。

### 3.2 认证与设置

- `authService`：注册（用户名 3-32、密码 ≥6、bcrypt cost 10）、登录、`GET /me`；JWT 30 天。
- `settingsService`：`ai` 配置（provider/baseUrl/model/temperature/maxTokens/apiKey）+ `rag` 开关 + `debugMode`；**apiKey AES-256-GCM 加密落库**（密钥 = `sha256(JWT_SECRET)`），GET 省略；`validatePatch` 校验 provider 白名单/temperature 0-2/maxTokens 1-1000000。

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

**性能特征**（真实 LLM 实测，`test-agent/REPORT.md`）：每次 invoke 恰好 6 个 trace 事件（intent_classified / agent_routed / tool_plan_created / llm_generate_start / llm_generate_end / validation_result）；单轮 10-15s（几乎全为 LLM 推理）；多工具链轮次 60-106s（工具链长度 × 推理时间线性放大）；120s 图超时兜底（`kpAgentService`）。

### 3.4 线索门控 — `agent/scriptContext.ts`

- **双轨设计**：剧本 JSON 含结构化 `clues[].requiredClues` / `scenes[].requiredClues` → 程序化判定；只有自由文本 `obtainCondition`/`transitionCondition`（原仓库剧本）→ 注入参考文本，**不拦截**（零回归）。
- **判定函数**：`findScene`（id/名称/文本子串，最长名匹配防歧义）、`sceneUnlocked`（返回 `true|false|null` + 缺失线索）、`getAvailableClues`（场景内未获且前置满足的线索清单）、`getSceneNpcs`。
- **注入点**（planTools Phase 3.5，narrative agent）：玩家文本提到非当前场景的已知场景 → 锁闭则提示缺失线索并**移除 required 中的 transition_scene**（防硬切）、解锁则提示可切换；探索意图 → 注入本场景可获线索清单（配合停滞强制解决"只检定不给线索"）。
- **数据来源**：storyContext（WS 帧可选字段，含 scriptId/openClues/sceneName），60s TTL 缓存，加载失败静默降级。

### 3.5 RAG（`rag/`）

- **双索引**：`vectorStore`（TF-IDF + 稠密混合，JSON 落盘）与 `graphStore`（LLM 抽取实体/关系 → union-find 社区 → 摘要）。
- **运行时**（`graphRag.buildContextWithGraph`）：向量召回（sceneId 候选策略防剧透）→ 图 BFS 2 跳扩展 → 结构化摘要（社区摘要/当前场景/关联节点/线索，边语义 CONTAIN/UNLOCK/TRANSITION）。
- **玩家会话图**（`userGraphStore`，DB）：investigator 根节点 + obtained/visited/performed/met 事件边，供摘要与结局报告。
- **文档解析**（`storyParsers`）：mammoth(docx)/epub2(epub)/jsdom(html)/pdf-parse+pdf-lib+tesseract.js OCR(pdf)。
- **embedding 双通道**：内置 transformers.js（text2vec-base-chinese-sentence，模型缓存 MODELS_DIR）优先，失败回退 OpenAI 兼容 `/v1/embeddings`。

### 3.6 WS 协议（`ws/index.ts`）

- 认证：`ws://host/ws?token=<JWT>`，无效关闭 **4001**；心跳 `ping→pong`。
- 帧：客户端 `kp:invoke {streamId, messages, storyContext?}` → 服务端 `chunk / trace / end / error`（同 streamId 并发独立，`send` 序列化失败兜底）。
- `rag:progress` 服务端→客户端推送（RAG 索引进度，userId→Socket 注册表）。

### 3.7 防御性设计（安全/鲁棒性）

- **输入校验**（`kpAgentService.normalizeMessages`）：非数组 → 400；缺 role/content → 400；assistant `tool_calls` 结构校验（id/name/arguments 非 string → 400）；**坏 arguments JSON 降级 `'{}'`**（不 500，对齐客户端 orchestrator）；tool 消息缺 tool_call_id → 400。
- **出站安全**（`outboundUrl`）：仅 http/https，拒绝 localhost/回环/私网/保留地址/IPv6 回环（SSRF）。
- **路径安全**（`pathSafety`）：`assertId` + realpath 防符号链接逃逸 + 按 userId 隔离目录。
- **错误映射**（`utils/errors`）：BadRequest 400 / Unauthorized 401 / NotFound 404 / Conflict 409 / Upstream 502，未知错误 500 通用文案。
- **WS 错误帧**：`invokeKpStream` 内部 catch + `handleKpInvoke` 双保险，任何异常转 `{type:'error'}`。

---

## 四、前端逻辑详解

### 4.1 游戏状态机（gameStore，核心 ~825 行）

**阶段流**：`story_selected → occupation_selected → playing → ended`（`useGameGuard` 守卫，非 playing/ended 或无角色卡重定向首页）。

**每轮玩家消息的主链路**（`sendPlayerMessage`）：

```
① 组装 chatMessages（最近 18 条 + 长期摘要 + 记忆点 + 角色卡 + RAG 上下文）
② runKpAgentLoop（kpSessionService）：
   循环 ≤8 轮：
     kpInvokeOnce（WS 流式 kp:invoke，带 storyContext）→ chunk 流式预览
     → 收到 toolCalls → processToolCalls（orchestrator 按名路由 5 handler 执行）
     → tool 结果 + assistant 消息回传 → 下一轮
   单轮失败 → trace_error + break（防卡死 8 轮）
③ 记忆提取（extractMemoryPoints 3-5 条 ≤40 字）→ kpMemory
④ 摘要触发：场景切换 / 每 5 回合 / 高影响工具回合（grant_clue/melee_attack/ranged_attack/san_check/trigger_insanity）
   → runLongTermSummarization（LLM 合并，收缩率 <85% 才落地，防劣化）
⑤ narrativeStall 计数、traceBus 全程打点
```

**状态/动作要点**：`cluesObtained` 结构化 `{id, description}`（旧存档自动迁移）；`transitionToScene` 记 `scenesVisited` + 触发摘要；HP≤0 → defeat 结局；**SAN≤0 → 先置 permanent 疯狂再 endGame**；`endGame` 冻结 endingState（含 finalSnapshot/clues/scenes）+ 跳结局页。

### 4.2 工具执行链（toolCalling）

- **orchestrator**：`processToolCalls` — JSON.parse 参数 → `NAME_TO_HANDLER` 路由 → 异常捕获返回 `error:` 前缀（回喂 LLM 让模型自纠）→ 逐条 trace `tool_executed`；DEV 模式校验 18 工具与 handler 覆盖一致。
- **5 个 handler 的规则实现**（真实 COC 规则）：
  - `checkHandler`：skill_check（奖惩骰、大失败规则 96+/100）、opposed_check、roll_dice。
  - `combatHandler`：melee/ranged_attack（含伤害加值 DB）、adjust_hp、apply_major_wound（重伤/濒死/即死）、first_aid/medicine。
  - `sanityHandler`：san_check（大失败最大骰）、trigger_insanity（**SAN≤0 永久 / 当日累计 ≥1/5 不定性 / 单次 ≥5 INT 检定临时**，1D10 发作表 + 恐惧症/躁狂症）、adjust_san、reset_day。
  - `resourceHandler`：adjust_mp、spend_luck。
  - `narrativeHandler`：transition_scene、grant_clue（带可选 clueId）、end_game（结局快照）。
- **toolContext**（`toolContextFactory`）：把 gameStore 的角色更新器 + 规则函数（parseDiceExpr/rollDamageBonus/奖惩骰）组装成 `ToolHandlerContext`。

### 4.3 平台适配层（platform）

- `bridge.ts`（PlatformBridge）：用 `uni.request/uploadFile/connectSocket` 统一三端，实现 shared `Bridge` 接口；401 清 token + `onUnauthorized` 事件；`kpInvokeStream` 惰性开 WS + streamId fan-out。
- `ws.ts`（WSService）：单连接多流；指数退避重连（1s→30s）；30s 心跳；帧路由 chunk/end/error/**trace**；error 后忽略同流后续帧（防超时竞态）。
- `config.ts`：`VITE_API_BASE` 优先，H5 回退同源 `/api`，小程序/App 无配置快速失败。
- `token.ts`：`aikp_token` uni storage + 401 事件总线。

### 4.4 Prompt 组装（kpPromptService）

- `BASE_INSTRUCTIONS`：KP 身份、防剧透（不主动预载全剧情）、严禁文字编骰（必须走工具）、战斗工具链强制、线索/场景管理规则、SAN≤0 疯狂规则。
- 上下文注入：`buildCharacterContext`（角色卡）+ `buildMemoryBlock`（kpMemory ≤30）+ `buildRecentTurnsBlock`（最近 5 轮每轮 120 字）+ 长期摘要 + RAG 检索结果。

---

## 五、数据流全景（一次完整对局）

```
玩家 ──> H5 页面 ──> gameStore.sendPlayerMessage
  ──> RAG 检索（/api/rag/context：向量召回 + 图扩展 + 会话图）
  ──> runKpAgentLoop ──> WS kp:invoke（messages + storyContext{scriptId,openClues,scene}）
  ──> 服务端：normalizeMessages 校验 → kpGraph 状态机
       （意图分类/短路 → planTools(含门控) → LLM 生成 → validate → forceTools）
  ──> 返回 end 帧 {content, toolCalls}（chunk 流式 + trace 事件）
  ──> 客户端：orchestrator 执行工具（掷骰/改属性/加线索/切场景/结局）
  ──> tool 结果回传 → 下一轮 invoke（最多 8 轮）
  ──> 叙事落屏 + 记忆提取 + 长程摘要（异步）
  ──> 存档 PUT /api/saves/:id（角色/线索/场景/消息全量快照）
```

**状态归属**：角色属性/线索/场景/疯狂状态在**客户端**（gameStore）为唯一真源；服务端是无状态图（每 invoke 新实例），通过 messages 历史 + storyContext 感知状态——这是「工具循环在客户端」架构的必然结果，也是长对话劣化的根因（见 §6）。

---

## 六、风险与遗留项（基于实测）

| 类别 | 问题 | 现状/建议 |
|---|---|---|
| 🔴 性能 | 长工具链轮次 60-106s（LLM 推理 × 链长）；长对话劣化 | 已缓解：工具结果 600 字符截断 + 单轮失败退出。完整方案（服务端会话缓存/历史压缩/摘要自适应）待专项 |
| 🟡 确定性 | 结局/线索/疯狂依赖 LLM 自觉的残余场景（如"破坏仪式"弱表达未触发 end_game） | 已修复强意图词；弱表达场景可考虑「门控场景完结时服务端强制 end_game」 |
| 🟡 协议 | storyContext 为可选字段，旧客户端不传则门控不生效 | 已在 README 标注；升级客户端即生效 |
| 🟢 遗留 | `scripts` 路由/桥接为死代码（无调用方）；`stories`/`scripts` DB 表未使用 | 清理或按需启用（剧本库） |
| 🟢 遗留 | 自由文本 `obtainCondition`/`transitionCondition` 无语义解析（维持双轨） | 结构化优先策略，有意为之 |
| 🟢 遗留 | 无 DB 迁移机制（幂等建表） | 结构变更需手动处理，建议引入版本号 |
| 🟢 测试 | test-agent 真实 LLM 用例偶发超时（120s step 上限，长链波动） | 已放宽至 240s；CI 不跑 test-agent（需 API Key） |

---

## 七、结论

- **架构**：三包 monorepo 职责清晰（server 无状态图 + client 状态持有 + shared 契约单一来源），协议契约化（api-contract.md），适配层（platform/bridge）为三端统一的关键。
- **智能**：LangGraph 状态机 + 18 工具 + 确定性兜底（SAN/结局/停滞/门控）已形成"LLM 自由发挥 + 程序化护栏"的稳健组合，实测完整性/鲁棒性均闭环。
- **安全**：认证、加密、SSRF、路径防护、输入校验五层齐全。
- **主要短板**：性能（LLM 推理主导）与长对话管理，属架构性约束，建议按 §6 路线推进专项优化。
