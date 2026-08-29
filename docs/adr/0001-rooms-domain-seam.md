# ADR-0001：房间 schema 收口于 RoomService 领域方法（roomStorage 为其私有 adapter）

- 状态：已接受（2026-08-28）
- 关联：架构评审候选 2（improve-codebase-architecture）；docs/ARCHITECTURE-MULTIPLAYER.md §四（D7/D-09/D-28）；DEVELOPMENT-LOG D-31

## 背景

`rooms`/`room_members` 的映射曾散布 5 个文件约 25 处裸 SQL（rooms.routes 内联 CRUD、roomService 内部 6 处、roomSettings.routes 的 state JSON 读改写、ws/rooms 的成员/身份查询）；「DB 权威 ↔ 内存 RoomService 实例」的一致性靠三套人工机制维持（REST 写后手动 `syncActiveRoom`、restore 列优先覆盖、`bufferPlayerChat` 每条玩家消息重读 `rooms.state`）。D-28 审查修复包修的是该结构的症状（REST 生命周期与活跃实例断链），不是病因。

## 决策

1. **REST 路由与 ws 层不接触房间表结构**：只调 RoomService 的领域方法（`createRoom` / `joinRoomByInviteCode` / `getRoomDetail` / `startRoom` / `bindRoomCharacter` / `setRoomTurnWindow` / `deleteRoomAsOwner` / `joinRoom` / `submitPlayerChat` / `isRoomMember`）。
2. **roomStorage**（`server/src/services/roomStorage.ts`）拥有全部房间 SQL，是 RoomService 的持久化 adapter；不对 routes/ws 暴露语义。
3. **对账在领域方法内部收口**：persist → `syncActiveRoom`（syncFromDb + 成员广播）；「每消息重读 DB」删除，`turnWindowMs` 运行时由活跃实例唯一持有。
4. **懒激活保持**：REST 建房只持久化，不激活实例；实例仅在 WS join 时 materialize（50 房压测与 TTL 语义不变）。
5. **wire 行为不变**：领域方法内部复用 D-28 已验证的 syncFromDb + 成员广播路径，REST/WS 响应与事件形状逐字节保持。

## 被否决的替代

- **(a) 仅集中 SQL**：storage 拥有 SQL 但对账仍由路由手动触发——SQL 有了家，病根（手动对账）仍在。
- **(b) storage 写后钩子通知实例**：引入间接层，通知时机与事务边界变模糊，YAGNI。

## 后果

- 新增房间字段/端点只动 roomStorage + 领域方法；领域行为可用 node:sqlite 临时库直测，不再需要「supertest + 动态 import 实例」组合拳。
- REST 外部输入以校验后参数进入领域方法，取代「每消息重读 DB」的污点隔离；外部 id 仍只作 DB 键（D-09 不变）。若 Mimosa 门禁对新形态报 finding，回退面为 bind/settings 两条路径。
- 顺带修复旧路由 `loadMembers` 的 snake/camel 转换错位（REST 触发的成员广播携带 `undefined` userId/characterId 的潜在 bug）。
