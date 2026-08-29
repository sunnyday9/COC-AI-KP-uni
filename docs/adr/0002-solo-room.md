# ADR-0002：单人游戏 = 单成员房间（无独立回合协议）

- 状态：已接受（2026-08-29）
- 关联：docs/ARCHITECTURE-MULTIPLAYER.md §五/§七 A4、FR-M9、D12；架构评审候选 7；ADR-0001

## 背景

单人模式与房间模式是两套并行回合协议——单人 = 客户端 `kp:turn` 帧（提示词客户端组装、RAG 客户端拉取、角色卡每回合重传、无 seq/重连/服务端持久化，存档是客户端整包快照）；房间 = 服务端权威事件流（seq 全序、订阅簿扇出、`rooms.state` 快照）。两条路径共享 `runKpTurn` 领域内核（D-34），但传输、上下文注入、持久化三面全部分叉，单人侧持有大量客户端权威逻辑（886 行 gameStore、kpPromptService、记忆抽取编排），与服务端权威单轨（ARCHITECTURE-MULTIPLAYER §四）矛盾。

## 决策

1. **单人游戏实现为 `kind='solo'` 的单成员房间**：不出现在房间列表、`turnWindowMs` 恒 0、出生即 playing——「确认角色卡」是一体领域动作（落角色卡 + 建 solo 房 + 绑卡 + start）。
2. **单人使用与多人完全相同的 wire 协议**（`room:join` / `room:action` / `room:event` / `room:sync`），无任何 solo 专用帧。
3. **删除面**：ws `kp:turn` 帧及其 handler、`POST /api/kp/invoke`、客户端 kpSessionService、直连 LLM 兜底（runDirectChat）全部删除；KP agent 可用性是纯服务端部署问题。
4. **上下文注入服务端收口**：提示词组装、RAG 检索上下文、记忆编排（kpMemory/长程摘要/抽取）移入服务端房间回合链路，数据落 `rooms.state`；userGraph 注入延后 A3。
5. **客户端形态**：gameStore 删除，页面消费 RoomClient（roomStore）；唯一乐观面 = 自己发出的消息。

## 被否决的替代

- **(a) 保留 kp:turn 作为单成员房间的快捷路径**：两协议永远双轨，每个房间能力（seq、重连、快照）都要在快捷路径重做一遍，收敛是假的。
- **(b) solo 用不落 DB 的虚拟内存房间**：违反 FR-M3「单机也落服务端」与 D12「存档=房间快照」，续玩要另做一套持久化。
- **(c) 房间路径加 kp:chunk 流式帧保住 token 流**：流式破坏全序事件流的 seq/补发语义，打字机效果不抵复杂度；本轮 KP 回复整段 `message_appended` 到达。

## 后果

- `rooms` 表加 `kind` 列（DEFAULT `'multi'`，存量数据不受影响）。
- solo 免费获得 seq 全序、断线重连、服务端持久化（重进房间=续玩）、骰子与 trace 事件——单人体验升级无需额外代码。
- multi 自动获得开场叙述与 RAG/记忆上下文（与 solo 同一回合链路）。
- DebugPanel 随客户端内部调试面（提示词/工具调用）消失而删除，调试面回到协议既有的 trace 事件；opening 回合失败不阻塞进入（首回合不是门闩）。
- 旧 saves 导入不在本 ADR 内（D12 P1 双向迁移工具，独立票）。
- 前提：无已部署客户端（v0.1.0 未发布），无兼容层。
