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

## 不重议的决策

- ADR-0001：房间 schema 只归 RoomService（经 roomStorage）所有，REST/ws 不接触。
- ADR-0002：单人游戏 = 单成员房间（`kind='solo'`），单人无独立回合协议；kp:turn 一侧全删，上下文注入服务端收口。
- D-09：外部 id 只进 DB，fs 用 uuid 文件名（Mimosa 污点链断链方案）。
- D7/D-10：单进程内存注册表 + 节流快照 + TTL 回收；Redis 是触发条件不是默认。
- 服务端权威单轨：客户端无规则、无工具循环（ARCHITECTURE-MULTIPLAYER §四）。
- ADR-0003：LLM 接入协议一等公民（协议模型 / 适配器 / 本地端点不豁免 / Responses 流式策略）。
