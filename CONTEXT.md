# CONTEXT.md — 领域词汇表

单上下文仓库（消费规则见 `docs/agents/domain.md`）。术语按「领域概念 → 代码落点」组织；术语被敲定或修正时同步更新本文件。

## 词汇表

### 房间（Room）
多人联机的会话单元。DB 权威 = `rooms`/`room_members` 两张表（列 + `rooms.state` JSON 快照）；运行时权威 = 活跃实例。

### 房间存储（RoomStorage）
房间领域的持久化 module：拥有 `rooms`/`room_members` 的全部 SQL 与对账原语。落点 `server/src/services/roomStorage.ts`。**REST 路由与 ws 层不接触房间表结构**（ADR-0001）；外部 id 只作为 DB 键进入查询（D-09）。

### RoomService（房间领域）
房间领域的唯一 interface：REST 与 ws 只通过它的领域方法（`createRoom` / `joinRoomByInviteCode` / `getRoomDetail` / `startRoom` / `bindRoomCharacter` / `setRoomTurnWindow` / `joinRoom` / `submitPlayerChat`…）触碰房间。每房间一个实例承载运行时状态。

### 活跃实例（active instance）
内存注册表中该房间的 RoomService 实例：状态真源（消息流/角色组/seq 水位）、串行队列、节流落库、TTL 回收。**懒激活**：仅在 WS join 时 materialize（REST 建房只持久化，不激活）。

### 对账（reconcile）
DB 权威与活跃实例的一致化：领域方法写库后对活跃实例执行 `syncFromDb`（列优先：`story_id`/`phase` 列覆盖 state 快照）+ 成员广播。实例 materialize 时的 restore 同样列优先。

### 房间订阅簿（RoomLedger）
房间事件流的传输决策 module：订阅注册表（socket↔room）、扇出挂接幂等、join/sync/action 的帧规划（该发什么帧）。落点 `server/src/ws/roomLedger.ts`；`ws/rooms.ts` 只是 JSON 编解码 + socket 生命周期 adapter。「缺口过大 → 全量兜底」的语义留在领域（D-16）。

### 回合窗口（turnWindowMs）
房主可调的 KP 回合合并窗口（0 = 严格排队）。运行时由活跃实例**唯一持有**；REST 设置经领域方法一次写库 + 同步实例，无每消息重读。

### 单人房间（Solo Room）
单人游戏的唯一形态：单成员房间（`kind='solo'`），不出现在房间列表（首页走「继续游戏」入口），回合窗口恒为 0，出生即 playing。wire 协议、持久化、事件流与多人房间完全一致——**单人没有独立的回合协议**（ADR-0002）。

### 等待室（Waiting Room / Lobby）
多人房间 `phase='lobby'` 的形态：成员经邀请码加入、创建并绑定角色卡、就绪；房主选择剧本并开局。等待室可闲聊（消息广播）但**不触发 KP 回合**。代码落点：房间页（`pages/game/rooms/room.vue`）在 lobby 阶段呈现等待室；开局后跳游戏页游玩。

### 房间剧本（room story）
多人局共用的剧本：**房主**已导入并索引的故事，`story_id` 存 `rooms` 表；KP 回合全程以房主账号解析剧本与 RAG 上下文（成员无需拥有该故事）。房主只可从**已索引**故事中选择（未索引不列入候选项，避免 KP 无原文空跑）。

### 开局门闩（start gate）
`lobby → playing` 的迁移约束：房主已选剧本 + **每名成员已绑定角色卡**，任一不满足则开局被拒（服务端 409 带缺项提示）。角色卡绑定是硬前提；就绪是软信号。

### 就绪（ready）
成员在等待室表示「已准备好开局」的软信号（与角色卡绑定相对）：房主可借此判断全员到位，但开局不强制等待全员就绪。

### 房主（owner）
房间的治理者（`room_members.role='owner'`）：选剧本、开局、踢出成员、转让房主。**房主离开或断线 → 立即转让**给剩余成员（最早加入者优先）；无其他成员则房间解散。

### 房主转让（owner transfer）
房主权限移交：房主主动转让给任一成员，或房主离开/断线时自动转让（无宽限期——刷新即易主是已知取舍）。被转让者成为新 owner 并获得治理权。

### 踢出（kick）
房主将某成员移出房间（删除其成员资格并广播）；被踢者客户端提示「已被移出房间」并回大厅。

### 房间视图模型（RoomClient）
客户端消费房间事件流的唯一视图层：事件应用 + 动作发送 + 唯一乐观面（自己发出的消息）。落点 `client/src/stores/roomStore.ts`；页面不持有领域状态、不组装提示词、不拉取 RAG（ADR-0002）。

### LLM 协议（LLM protocol）
用户可选的 LLM 接入方式，一等公民配置维度：`openai_chat`（Chat Completions）/ `openai_responses`（Responses API）/ `anthropic_messages`（Messages API）/ `google_compatible`（Gemini，遗留）。`settings.ai.protocol` 是唯一协议真源；不随 provider 推导（ADR-0003）。

### 协议适配器（protocol adapter）
把内部统一格式（OpenAI 风格 `ChatMessage[]` + `tools`）翻译成特定协议请求/响应并归一化返回 `{ content, chunks, toolCalls }` 的模块。转换（system 抽取、assistant tool_calls ↔ tool_use、工具结果回填）是各适配器私有实现，不做跨协议统一层。落点 `server/src/services/llm/*.ts`（ADR-0003）。

### 嵌入端点（embedding endpoint）
RAG 嵌入固定走 OpenAI 兼容端点 `POST {baseUrl}/v1/embeddings`，与主协议解耦——协议切到 anthropic/responses 时嵌入仍打同一 baseUrl 的 OpenAI 格式端点（anthropic/google 无等价嵌入 API）。落点 `server/src/rag/embedding.ts`（Q5-A）。

### 模板（template）
已废除的 provider 概念残留：旧 `provider` 字段（openai/deepseek/gemini/…）作为「默认 endpoint + 默认模型列表」的速填模板，不再参与协议解析，仅设置页点选时填充 `protocol + baseUrl`。自填 endpoint 后模板失去唯一性（Q1-B 删 provider，模板随之移除，仅遗留配置经映射表惰性识别）。

### KP 模型（self-trained KP model）
为「更会当守秘人」在项目回合契约上 SFT 出的自训模型：输出与现有回合管线一致（中文叙事正文 + 工具调用），上下文形态由服务端提示词构造决定。基座 Qwen3-8B；训练框架/算力分工/评测 gate 见 ADR-0006。

### 内置模型（built-in model）
服务端持有端点配置、用户无需自带 key 即可使用的守秘人模型，与 BYOK（用户自带 key）相对。**目标态**：KP 模型过三层评测 gate 后才启动 serving/配额/降级独立票；上线前自用走用户自己配置的端点。

### wire 采样日志（wire sampling log）
KP 回合管线上的唯一新增缝（T1，spec #36 / ADR-0006）：每个真实 KP 回合把完整 wire 消息序列——原始 assistant `tool_calls`（含参数 JSON）、工具结果回填（线上同形态：摘要+截断）、当轮 RAG 注入原文、最终叙事回复——落库到 node:sqlite 的 `kp_wire_samples` 表（读走 `wireSampleService.listWireSamplesForRoom`，后续导出器共用）。默认开启，`KP_WIRE_SAMPLING=0` 关闭（关闭时零额外写入）；MOCK_AI 确定性脚本回合与图中断/无叙事回合不采样；数据不进 `rooms.state`，房间快照协议零改动（ADR-0001/0002）。

### 金样本评测集（golden eval set）
三层评测的第二层资产（T3，spec #36 / ADR-0006）：57 条标准情境 → 期望工具/参数，覆盖 24 个 COC 工具主组合；评测 harness 对任意 openai_chat 端点产出格式遵循率与裁定正确率 + 可分类失败明细（未调工具/调错工具/参数错/文字骰点）。判定规则与请求形态都**单源复用产品代码**：格式判定用 `shared/tools/kpValidation.ts`（kpGraph validate 节点同源），请求构建用 `kpPromptService` 提示词纯函数 + 线上同形态工具结果回填。落点 `training/eval/`（独立工作区，不入 server 运行时依赖树）；基线报告落盘 `training/eval/reports/`，是 #42 gate 的对照基准。

### 校验规则单源（kpValidation）
`shared/tools/kpValidation.ts`：文字模拟骰子正则（TEXT_SIMULATION_PATTERNS/hasTextSimulation/cleanTextSimulation）、工具等价表（TOOL_EQUIVALENTS：melee/ranged_attack 隐含 skill_check+roll_dice+adjust_hp）与 required 覆盖判定。产品侧质量门槛（kpGraph validate 节点）与训练评测侧客观评测器（training/eval）共用这一份，防止两处漂移。

## 不重议的决策

- ADR-0001：房间 schema 只归 RoomService（经 roomStorage）所有，REST/ws 不接触。
- ADR-0002：单人游戏 = 单成员房间（`kind='solo'`），单人无独立回合协议；kp:turn 一侧全删，上下文注入服务端收口。
- D-09：外部 id 只进 DB，fs 用 uuid 文件名（Mimosa 污点链断链方案）。
- D7/D-10：单进程内存注册表 + 节流快照 + TTL 回收；Redis 是触发条件不是默认。
- 服务端权威单轨：客户端无规则、无工具循环（ARCHITECTURE-MULTIPLAYER §四）。
- ADR-0003：LLM 接入协议一等公民（协议模型 / 适配器 / 本地端点不豁免 / Responses 流式策略）。
