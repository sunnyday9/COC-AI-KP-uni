# ADR-0005：多人房间游戏流程 — 等待室/开局门闩/房主治理（等待室形态）

- 状态：已接受（2026-09-03）
- 关联：#26（Feature 多人房间游戏流程）、ADR-0001/0002/0004、docs/ARCHITECTURE-MULTIPLAYER.md

## 背景

ADR-0004 UI 重设计验收后，多人房间只有「创建/邀请码加入/聊天/KP 回合」雏形（`pages/game/rooms/room.vue` 把等待、绑卡、聊天、开局挤在一页，房主选剧本写死取第一个已索引故事），缺完整开局流程与游戏中协作展示。用户反馈（#26）要求：创建房间后进入**等待室**（房主选故事、每人建个人角色卡、准备、开局），游戏中可查看所有成员档案。

现状事实（侦查）：`rooms.phase` 值域已有 lobby/playing/ended；`POST /rooms` 已支持可选 storyId；`POST /rooms/:id/start` 已有 storyId + 非房主 409；`POST /rooms/:id/character` 已支持绑卡（本人卡 + 房内唯一校验）；房间事件经 `room_meta` 广播全量 members；KP 回合全程以**房主账号**解析剧本/RAG（`roomService.fetchRagContext` 等用 ownerId）。缺口：**无成员主动离开/踢出 API**（WS `room:leave` 只退订阅不删 room_members、不广播，成员列表只增不减）；lobby 即可聊天并触发 KP（无 phase gate）；game 页只显示自己档案（数据 roomStore.characters 已全员有）；故事读取无「房主未索引→静默空跑」防护。

## 决策

1. **分工**：`room.vue` 改为**等待室**专用（lobby：成员列表含绑卡/就绪状态、房主选已索引故事、准备按钮、开局/踢出/转让、被移出提示）；**开局成功 → 房主与成员跳 `game/index.vue`** 游玩（与单人汇合，复用三栏/消息体系/沉浸退出）。game 页维持无 lobby 分支。
2. **lobby 聊天不触发 KP**：等待室保留聊天（社交/房主宣布），但 `phase='lobby'` 时成员消息只广播不入 KP 回合队列；开局（playing）后才触发 KP。
3. **就绪存 `room_members`**：加 `ready` 列（INTEGER DEFAULT 0，幂等迁移仿 kind 列）；就绪/绑卡变化 → 重发 `room_meta` 广播（wire 零扩展）。就绪是**软信号**。
4. **开局门闩（硬）**：房主点开始 → 服务端校验「已选已索引剧本 + 每名成员已绑定角色卡」；不满足 → 409 带缺项提示（如「N 名成员未绑定角色卡」）。不等待全员就绪。
5. **成员治理（REST 领域动作）**：房主踢出 `DELETE /api/rooms/:id/members/:userId`（owner only：删行 + 广播 + 被踢者提示回大厅）；房主主动转让 `POST /api/rooms/:id/transfer`（指定成员成为新 owner）。
6. **房主离开/断线立即转让**：房主主动 leave 或 WS 断线 → **立即**把 owner 转让给剩余最早成员（无宽限期——刷新即易主是已知取舍）；无其他成员 → 房间解散。断线检测复用现有 ws disconnect 事件 + 活跃实例。
7. **剧本源**：房主只从**已索引**故事中选（未索引不列入候选项）。房间故事 = 房主已索引故事，KP 全程 ownerId 解析（现架构已是，零改动；AI 计费/配置跟随房主是既有事实）。
8. **队友档案切换**：game 页桌面右栏 + 移动 sheet 加成员切换器（自己/各成员），选中显示对应角色卡（未绑卡显示空态）；数据源 roomStore.characters（服务端已全量推）。
9. **playing 后锁房**：开局后邀请码不可再加入（observer 旁观留后续）。

## 被否决的替代

- **(a) room.vue 保持聊天+等待合一，playing 后原地变游戏 UI**：需把三栏/消息组件搬进 room.vue 重复实现，且与单人「建卡→进 game」心智分叉；游戏页已成熟，跳转复用最省。
- **(b) 就绪存 rooms.state JSON**：查询/对账绕，且与绑卡（room_members.character_id 列）哲学不一致；列权威 + 对账同步更清晰。
- **(c) 房主断线转让带宽限定时器（60s）**：实现重（定时器管理），且本波无需防误刷——刷新易主可接受；最简 = 立即转让。
- **(d) lobby 禁聊**：等待室社交有价值，只 gate KP 即可；全禁改动 e2e 最大且损失房主宣布体验。
- **(e) 成员绑卡允许选已有卡（弹层二选一）**：体验分支多；默认新建（复用 occupation 向导多人模式）+ 绑定最顺，已有卡选择留后续。

## 后果

- `room_members` 加 `ready` 列；rooms/room_members 增成员治理相关 REST（leave/kick/transfer）+ 开局门闩校验（改 start 语义：缺剧本/缺绑卡 → 409）。
- occupation 向导加多人模式参数（`mode=multi&roomId`：完成 = characterCreate + bindRoomCharacter + 回跳等待室，storyId 可空；solo 逻辑零影响）。
- game 页档案区加成员切换（纯 UI，数据已在 roomStore）。
- e2e：rooms.journey 重写为完整多人局（建房→加入→选故事→门闩→绑卡/准备→开局→game 聊天/KP/重连）；h5.journey 单人链路不动；multiroom WS 层若 lobby 禁 KP 需同步。
- 出界（后续票）：observer 旁观角色、多人结局/存档归属、AI 按触发成员计费、故事跨账号共享。
