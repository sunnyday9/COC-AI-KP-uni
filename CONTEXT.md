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

### 回合窗口（turnWindowMs）
房主可调的 KP 回合合并窗口（0 = 严格排队）。运行时由活跃实例**唯一持有**；REST 设置经领域方法一次写库 + 同步实例，无每消息重读。

## 不重议的决策

- ADR-0001：房间 schema 只归 RoomService（经 roomStorage）所有，REST/ws 不接触。
- D-09：外部 id 只进 DB，fs 用 uuid 文件名（Mimosa 污点链断链方案）。
- D7/D-10：单进程内存注册表 + 节流快照 + TTL 回收；Redis 是触发条件不是默认。
- 服务端权威单轨：客户端无规则、无工具循环（ARCHITECTURE-MULTIPLAYER §四）。
