# 多人联机 + 多端同步：架构方案 v2.0（无兼容包袱版）

> 版本：v2.0（2026-08-19）· 基线：feature/coc7-rules-perf-optimization @ e2c522a
> 前提：**客户端尚未部署**，不存在已上线客户端需要兼容——本方案为单轨架构，无任何双轨/兼容开关。
> 目标：在"原需求（三端单人跑团）+ 新需求（多人联机、多端同步）"下重新设计系统架构，最大程度复用现有代码。

---

## 〇、v2.0 相对 v1.0 的关键差异

| 项 | v1.0（兼容版） | v2.0（本版） |
|---|---|---|
| 工具循环 | 服务端图内循环 + `executeTools` 双轨开关（旧客户端保留客户端循环） | **唯一路径**：服务端图内循环，客户端无工具执行能力 |
| 会话上下文 | storyContext 由客户端上传（兼容旧客户端）+ 服务端自持并存 | **唯一路径**：服务端自持全部会话上下文，客户端不传状态 |
| 规则引擎位置 | shared/rule-engine（兼顾客户端复用） | **server/src/rule-engine**（客户端纯渲染，无规则代码） |
| 协议 | 兼容旧帧 + 新房间帧并存 | 全新房间协议，单帧体系 |
| 客户端状态 | 本地镜像（兼容迁移） | 纯视图模型（从事件流构建），无任何权威 |
| 单机模式 | 单成员房间（兼容层） | 单成员房间（唯一模式，从设计上统一） |
| 客户端 kpSessionService | 保留兼容入口 | 删除，循环逻辑移入服务端 |
| 离线游玩 | 未提 | 明确排除（在线前提；P3 可选评估） |

---

## 一、背景与设计前提

### 1.1 原需求（保持不变）

1. **三端**：H5 / 微信小程序 / App（uni-app），一套代码；
2. **单人跑团**：导入剧本 → RAG 索引 → 创建角色 → 与 AI KP 文字跑团 → 18 个 COC 工具驱动规则 → 线索门控推进 → 结局 → 存档/读档；
3. **服务端**：Express + LangGraph KP Agent + RAG + SQLite，Node ≥24 零原生依赖；
4. **无 LLM 可测**：MOCK_AI 确定性脚本全链路测试；
5. **安全基线**：JWT、API Key 加密、SSRF、路径防护、输入校验。

### 1.2 新需求

6. **多端同步**：同一账号在多设备/多端同时在线，共享同一局的状态与消息，任何一端操作全员可见；
7. **多人联机**：多个玩家在同一房间跑团，共享剧本/消息/规则执行，AI KP 一视同仁地主持；
8. **房间化**：创建/加入/离开房间，房主管理。

### 1.3 根本矛盾（与 v1.0 相同，但无妥协空间）

现状是**客户端权威**架构（状态真源在 gameStore、工具在客户端执行）。多端同步要求状态在公共权威可见，多人联机要求规则执行可校验、防作弊、共享上下文——两者都指向**状态权威必须迁移到服务端**。既然没有已部署客户端，这次迁移没有理由保留任何双轨。

### 1.4 明确排除（设计边界）

- **离线单机游玩**：本方案为在线架构（LLM/RAG/规则/状态都在服务端）；离线游玩若未来需要，作为 P3 单独评估（service worker + 本地快照），不影响本架构；
- **P2P/WebRTC**：小程序与公网 NAT 不可靠，且 LLM/RAG 天然在服务端，无收益；
- **多实例/Redis**：目标规模（≤100 并发房间、单房间 ≤6 调查员）单进程内存足够，Redis 按触发条件引入（见 NFR-M5）。

---

## 二、需求清单

### 2.1 Functional Requirements

**原有（保留，语义不变）**

| 编号 | 需求 | 现状映射 |
|---|---|---|
| FR-1 | 注册/登录，多用户隔离 | auth.routes（复用） |
| FR-2 | 剧本导入（txt/md/json/pdf/docx/epub/html，PDF OCR） | storyParsers（复用） |
| FR-3 | RAG 向量+图谱索引 | rag/*（复用，归属语义改 ownerId） |
| FR-4 | 角色创建（职业/投骰/技能/姓名） | character-create 页 + coc7Character（复用） |
| FR-5 | 与 AI KP 流式对话 | kpGraph + WS（复用+改造） |
| FR-6 | 18 个 COC 工具驱动规则 | rule-engine（从 client 搬入 server） |
| FR-7 | 确定性兜底（SAN/结局/停滞/门控） | kpGraph（复用） |
| FR-8 | 线索门控（requiredClues 程序化判定） | scriptContext（复用） |
| FR-9 | 结局结算与报告 | endingState + game-end 页（复用） |
| FR-10 | AI 设置（provider/model/key）服务端持久化 | settingsService（复用） |
| FR-11 | 调试面板（RAG 检查 + KP trace） | rag-inspector + DebugPanel（复用） |

**新增（多人/多端）**

| 编号 | 需求 | 优先级 | 要点 |
|---|---|---|---|
| FR-M1 | 房间生命周期：创建/加入/离开/解散 | P0 | 邀请码（6 位随机）；owner 可解散 |
| FR-M2 | 房间共享剧本：owner 选择/导入，RAG 索引按 ownerId 共享 | P0 | 成员只读；跨房间同剧本复用索引 |
| FR-M3 | 每玩家角色卡：按 userId 持久化，加入房间绑定 | P0 | 一人一卡（绑定后他人不可用）；单机也落服务端 |
| FR-M4 | 共享消息流：KP/玩家消息全员可见，带作者标识 | P0 | 消息 = 房间广播事件 |
| FR-M5 | 服务端权威规则执行：骰子/属性/线索/场景/结局全部服务端产生并广播 | P0 | 客户端无规则代码，无法作弊 |
| FR-M6 | 状态增量广播：事件流（seq 全序）驱动所有在线端一致 | P0 | 见 §6 协议 |
| FR-M7 | 断线重连恢复：快照 + 游标增量补齐 | P0 | 会话 TTL 30min |
| FR-M8 | 多端同步：同账号多设备同房间，事件流天然一致 | P0 | 多连接订阅同一房间 |
| FR-M9 | 单人模式 = 单成员房间（同一代码路径，行为不变） | P0 | 首页"开始游戏"隐式建房 |
| FR-M10 | 多人回合处理：同轮多玩家行动合并进图（窗口可调） | P1 | turnWindowMs 默认 5s，0=严格排队 |
| FR-M11 | 房主控制：开始/结束/推进结算/房间设置/AI 配置（用房主 settings） | P1 | |
| FR-M12 | 旧存档迁移：saves 表历史快照导入单人房间；房间快照可导出 | P1 | 数据在服务端，无客户端包袱 |
| FR-M13 | 结局房间级共享（所有成员可见） | P1 | |
| FR-M14 | 观战模式（observer 只读） | P2 | |
| FR-M15 | 多角色卡归属：characterId 校验，LLM 选错人自动回退行动者 | P1 | 见 D5 |

### 2.2 Non-Functional Requirements

| 编号 | 需求 | 目标 | 权衡 |
|---|---|---|---|
| NFR-M1 | 一致性 | 房间内全序事件（服务端串行分配 seq），在线端完全一致 | 服务端串行换强一致；小房间人数下无需 CRDT |
| NFR-M2 | 可用性 | 断线 30s 内重连恢复；会话 TTL 30min；崩溃按快照重建（丢失 ≤ 快照间隔变更） | 内存 + 节流快照，不落全量 DB |
| NFR-M3 | 性能 | 工具链一次网络往返（现 8 次）；单轮 LLM 延迟不变；LLM 并发上限可配置（按房间队列） | 吞吐上限 = LLM 提供商并发 |
| NFR-M4 | 安全 | 邀请码鉴权；动作归属校验（成员只能动自己的角色）；骰子服务端产生（防作弊）；房间操作鉴权 | 服务端权威是防作弊的前提 |
| NFR-M5 | 可扩展 | ≤100 并发活跃房间、单房间 ≤6 调查员 + observer；超限 → 多实例 + Redis 会话锁/事件总线 | 触发条件式引入，不提前上基础设施 |
| NFR-M6 | 可测试性 | MOCK_AI 全链路可测；**双客户端 E2E**（两浏览器页同房间断言一致） | 复用现有 MOCK/E2E |
| NFR-M7 | 兼容性 | 单人玩法行为不回归（无旧客户端，仅保单人体验）；旧存档可导入 | 兼容对象从"客户端"变为"单人体验+数据" |
| NFR-M8 | 可观测性 | 房间级 trace（roomId + turnId 维度）；事件流可回放 | 复用 traceBus 设计 |
| NFR-M9 | 成本 | 零新增基础设施（Node ≥24、SQLite、内存 Map）；部署单进程即可 | 多实例是触发条件而非默认 |

---

## 三、目标架构总览

```
┌─────────────────────────── 客户端（三端，纯视图层） ───────────────────────────┐
│  Pages/Components（复用现有 UI 代码，仅改数据来源）                              │
│  ┌─────────────────────────────────────────────────────────────┐               │
│  │ RoomClient（新，替代 gameStore 权威角色）                      │               │
│  │   · 视图模型：messages / characters / clues / scene / phase   │               │
│  │     —— 全部从服务端事件流构建，无本地权威                          │               │
│  │   · 事件应用器：按 seq 应用 message_appended / state_patch /   │               │
│  │     dice_result / room_meta / trace                           │               │
│  │   · 动作发送器：sendAction（聊天/表态/请求重掷…）→ WS             │               │
│  │   · 乐观 UI：消息立即上屏（pending 态），服务端广播后对账           │               │
│  └─────────────────────────────────────────────────────────────┘               │
│  Platform Bridge / WSService（复用，扩展房间帧）                                │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │ REST（auth/settings/stories/rag/saves/rooms）
                                   │ WS（房间事件流）
┌──────────────────────────────────┴─────────────────────────────────────────────┐
│                             服务端（唯一权威）                                    │
│  Routes（复用 8 组 + 新增 /api/rooms/*）                                          │
│  ┌───────────────────────────────────────────────────────────────┐              │
│  │ RoomService（新）—— 每房间一个实例：                              │              │
│  │   · 状态真源：角色组 / 线索 / 场景 / 消息流 / 结局 / 回合队列 / seq │              │
│  │   · 串行队列：动作 → 校验 → seq 分配 → 处理 → 事件广播             │              │
│  │   · KP 图执行：图内工具循环（服务端执行，无客户端回环）             │              │
│  │   · 快照：变更节流落库 + TTL 回收 + 重连游标                      │              │
│  └───────────────────────────────────────────────────────────────┘              │
│  RuleEngine（从 client 搬入，server/src/rule-engine）                            │
│    —— toolCalling handlers + logic + dice + data（137 单测随迁）                 │
│  kpGraph / scriptContext / kpAgentService（复用 + 改造：服务端循环）               │
│  RAG（复用；userId → ownerId 语义）                                               │
│  ws/index（复用；房间事件转发）                                                    │
│  DB：现有 7 表 + rooms / characters / room_members                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**架构三句话**：
1. 客户端只"发动作 + 渲染事件"，没有任何状态权威与规则执行；
2. 服务端是唯一权威：状态、规则、骰子、KP 图循环全部服务端；
3. 单人 = 单成员房间，多人 = 多成员房间，同一套代码路径。

---

## 四、核心设计决策

### D1 状态权威：服务端房间会话（唯一选项）

客户端权威 + 广播无法防作弊、无法解决状态冲突、多端不同步；P2P 不现实。**服务端房间会话**是唯一满足 FR-M5/M6/M8 + NFR-M4 的方案。无兼容包袱后无任何双轨讨论余地。

### D2 规则引擎：server/src/rule-engine

客户端不再执行规则 → 引擎放服务端。`ToolHandlerContext` 的 `update*` 回调在服务端实现为「状态变更 → 发射 state_patch 事件」。展示文本（骰子结果/系统消息）由引擎生成后随事件广播，客户端只渲染文本与动画，**不需要任何规则代码**。

迁移内容（从 client 搬入，零逻辑改动）：
- `toolCalling/handlers/*` + `orchestrator.ts` + `types.ts`
- `logic/*` + `data/coc7.ts` + `data/insanityTables.ts`
- `services/diceService.ts`
- traceBus 引用改为服务端日志/事件发射（唯一耦合点，注入化）

137 个现有单测随迁到 server 包。

### D3 KP 图：服务端图内工具循环（唯一路径）

```
RoomService 回合处理：
  合并后的玩家消息 → 图执行：
    analyzeInput → planTools → generate → validate
    → 有 toolCalls → RuleEngine 执行（服务端）→ 结果注入 messages（复用 summarize/truncate）
    → 继续图（≤8 轮）→ 无 toolCalls → 结束
  → 广播：message_appended + state_patch* + dice_result* + trace
```

- 工具链 8 次 WS 往返 → 1 次；
- 续接轮（tool_continuation）做短调用（低 maxTokens，P0 性能项）：
- 上下文服务端自持，不再重复上传；
- 坏 JSON 重试路径消失（服务端自构造 tool 结果）；
- mockAi 的续接逻辑（mockContinuation 按工具结果推下一步）天然适配服务端循环，MOCK 模式零改动。

### D4 多人消息进图：回合窗口合并

- 窗口 `turnWindowMs`（默认 5s，房主可调，0 = 严格排队）：收到玩家消息后开启窗口，收集同轮多人行动，合并为带 `【玩家A】…【玩家B】…` 标记的 user 消息进图；
- 一次 LLM 推理覆盖多人行动，叙事连续；
- 窗口超时立即处理；无多人时等价于现在（单机无感知延迟——单人消息立即处理，无需等待）。

### D5 工具参数的角色标识：characterId（必填于多人，缺省回退行动者）

- `shared/tools/cocTools.ts`：skill_check / san_check / adjust_hp / adjust_san / adjust_mp / spend_luck / apply_major_wound / melee_attack / ranged_attack / trigger_insanity 增加 `characterId: string`（多人模式必填，单人模式可省）；
- prompt 注入全部角色卡（`## 调查员：<名字>（id: xxx）…`）；
- 服务端校验：characterId 缺失 → 默认当前回合行动者；指向不存在角色 → 拒绝并回喂 LLM 修正（不中断房间）。

### D6 同步协议：全序事件流 + 快照游标

- 事件帧：`{seq, type, payload}`，seq 由 RoomService 串行分配；
- 类型：`message_appended` / `state_patch`（角色/线索/场景/结局增量）/ `dice_result` / `room_meta` / `trace`；
- 加入/重连：`room:sync {lastSeq}` → 补发增量；缺口过大或快照过期 → 全量快照；
- 客户端按 seq 应用到视图模型（乱序帧缓冲，按序应用）。

### D7 会话存储：内存 + 节流快照 + TTL

- 活跃房间状态在内存（每房间 ≈ 消息流 + 角色组 + 线索，几百 KB 级，×100 房间无压力）；
- 快照：变更节流落库（≥N 事件或 ≥T 秒），崩溃/TTL 回收后按快照重建；
- TTL 30min 无活跃 → 快照 + 回收；
- 多实例触发条件：活跃房间 > 100 或需要跨实例部署 → Redis 会话锁 + 事件总线（明确为触发条件，不默认）。

### D8 RAG 归属：ownerId（剧本所有者）

- `rag/*` 全部 `userId → ownerId` 语义重命名（算法零改动）；
- 房间共享剧本：索引归属 = 上传者/房主，成员只读引用；跨房间同剧本复用索引；
- 删除权限仅所有者。

### D9 角色卡：characters 表（按 userId）

- 创建流程（复用 character-create 页）POST 服务端，落 `characters` 表；
- 加入房间时选择一张卡绑定（一人一卡，绑定后他人不可用）；
- 单人模式同样落服务端（登录即有，多端可复用）。

### D10 AI 配置：房主 settings

- 房间 AI 配置 = 房主服务端 settings（provider/model/key），成员零配置；
- 单人房间 = 自己的 settings（现状不变）。

### D11 权限模型

| 角色 | 权限 |
|---|---|
| owner | 房间设置（含 AI 配置/turnWindowMs）、开始/结束/结算推进、踢人、解散、导入剧本 |
| member | 发消息、操作自己的角色（工具归属校验）、申请绑定角色卡 |
| observer | 只读（看消息/状态，不参与） |

### D12 存档语义统一

- **存档 = 房间快照**：单人存档即单人房间快照（同一表 rooms.state）；
- 旧 saves 表历史数据 → 导入单人房间（P1 迁移工具，双向：房间快照可导出为旧格式）；
- 多端换设备：登录 → 打开房间列表（= 存档列表）→ 继续。

---

## 五、代码复用与迁移映射（更新版）

| 现有模块 | 去向 | 改动量 | 说明 |
|---|---|---|---|
| `client/src/toolCalling/*` | **搬至 `server/src/rule-engine/`** | 小 | 零逻辑改动；traceBus 注入化 |
| `client/src/logic/*` + `data/*` | **搬至 `server/src/rule-engine/`** | 零 | 137 单测随迁 |
| `client/src/services/diceService.ts` | **搬至 `server/src/rule-engine/`** | 零 | |
| `client/src/services/kpSessionService.ts` | **删除**（循环逻辑移入 RoomService） | 大（删除） | summarize/truncate 搬 server |
| `server/src/agent/kpGraph.ts` | 复用 + 改造 | 中 | 多角色卡 prompt、characterId、执行回调注入（服务端循环） |
| `server/src/services/kpAgentService.ts` | 复用 + 扩展 | 小 | 服务端循环模式（无兼容开关，直接改造） |
| `server/src/agent/scriptContext.ts` | 复用 | 零 | |
| `server/src/rag/*` | 复用 + userId→ownerId | 小 | 语义重命名 |
| `server/src/routes/*` | 复用；新增 rooms.routes.ts | 中 | |
| `server/src/ws/index.ts` | 复用 + 房间事件转发 | 中 | 订阅组 + 扇出 + sync |
| `server/src/db/index.ts` | 复用 + 3 新表 | 小 | rooms / characters / room_members |
| `client/src/stores/gameStore.ts` | **重构为 RoomClient 视图模型** | 大 | 事件应用 + 动作发送；render 接口尽量保持 |
| `client/src/platform/bridge.ts` + `ws.ts` | 复用 + 扩展 | 小 | 房间帧 |
| `client/src/pages/*` + components | 复用 | 小 | 消息作者标识、角色切换器 |
| `client/src/services/kpPromptService.ts` | 复用 + 多角色卡 | 小 | 搬 server 或由 server 引用 shared |
| `server/src/services/mockAi.ts` | 复用 | 零 | |
| `e2e/` + `test-agent/` | 复用 + 扩展 | 中 | 双客户端 E2E；test-agent 简化（无 toolExecutor） |
| `shared/types/*` | 复用 + 扩展 | 小 | Room 类型、事件类型 |

**复用率**：约 70-75% 直接复用或仅搬迁；净新增集中在 RoomService、房间协议、双客户端 E2E。

---

## 六、数据模型与协议

### 6.1 新增表

```sql
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,        -- 6 位随机
  story_id TEXT,                            -- 共享剧本（RAG ownerId = 上传者）
  phase TEXT NOT NULL DEFAULT 'lobby',      -- lobby / playing / ended
  state TEXT NOT NULL,                      -- 全量快照 JSON（角色组/线索/场景/消息/结局/seq 水位）
  version INTEGER NOT NULL DEFAULT 0,       -- 快照版本（乐观并发）
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sheet TEXT NOT NULL,                      -- COCCharacterSheet JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,                       -- owner / member / observer
  character_id TEXT,
  PRIMARY KEY (room_id, user_id)
);
```

### 6.2 协议帧（WS，v1 单帧体系）

```
客户端 → 服务端：
  room:join      { roomId? , inviteCode? }        -- 建/加房间
  room:leave     { roomId }
  room:action    { roomId, action: { type: 'chat'|'request', payload } }
  room:sync      { roomId, lastSeq }
  room:manage    { roomId, op, payload }           -- owner 操作（踢人/设置/开始…）
服务端 → 客户端：
  room:state     { roomId, snapshot, seq }         -- 全量（加入/快照过期）
  room:event     { roomId, seq, type, payload }    -- 增量事件流（全序）
  room:error     { roomId, error }
```

事件类型（v1）：

| type | payload | 用途 |
|---|---|---|
| `message_appended` | pendingId / author{userId, roleName} / content / kind | 消息流（含乐观对账） |
| `state_patch` | path + value | 角色属性/线索/场景/结局增量 |
| `dice_result` | seed / rolls[] / expr / displayText | 骰子动画 |
| `room_meta` | phase / turnWindowMs / members[] | 房间状态 |
| `trace` | traceEvents | DebugPanel |

### 6.3 动作处理时序（服务端，每房间串行）

```
room:action → 校验（成员/权限/归属）→ seq = ++watermark
  → chat：回合窗口合并 → KP 图（服务端循环）→ 广播事件组
  → request：表态/重掷请求 → 入队等待 KP 处理
  → 变更后：节流快照 + TTL 刷新
```

---

## 七、分阶段迁移计划

### Phase A：规则引擎下沉 + 服务端权威执行（单人，2 周）

| 步骤 | 内容 | 关键文件 |
|---|---|---|
| A1 | toolCalling/logic/data/dice 搬至 `server/src/rule-engine/`；traceBus 注入化；137 单测随迁 | server/src/rule-engine/* |
| A2 | kpAgentService + kpGraph 改造为服务端图内工具循环（循环逻辑从 kpSessionService 移入，复用 summarize/truncate） | kpAgentService.ts、kpGraph.ts |
| A3 | 单用户会话上下文（RoomService 单成员雏形）：消息流/角色/线索/场景服务端自持 | 新 sessionContext.ts |
| A4 | gameStore → RoomClient 视图模型：事件应用 + 动作发送 + 乐观 UI；删除 kpSessionService | gameStore.ts、kpSessionService.ts（删除） |
| A5 | 存档迁移：saves 旧快照 ↔ 会话快照互转 | saveService.ts |

**验收**：MOCK_AI 下 H5 E2E 全绿（工具链闭环断言改为断言服务端广播事件）；tsc 零错误；137 + 220 单测全绿；test-agent 43 用例回归（toolExecutor 删除）；真实 LLM 性能对比（战斗链 60-106s → 图内多次短调用）。

### Phase B：房间与多人（3 周）

| 步骤 | 内容 | 关键文件 |
|---|---|---|
| B1 | rooms/characters/room_members 表 + RoomService（队列/seq/快照/TTL） | db、新 roomService.ts |
| B2 | /api/rooms/* 路由 + 邀请码 | rooms.routes.ts |
| B3 | WS 房间事件流：订阅组/扇出/sync 游标 | ws/index.ts |
| B4 | 角色卡持久化 + 房间绑定（复用 character-create 页） | pages/character/* |
| B5 | characterId 扩展 + 多角色卡 prompt + 归属校验 | cocTools.ts、kpGraph、kpPromptService |
| B6 | 回合窗口合并 + 房主控制 + 房间级 AI 配置（owner settings） | RoomService、settings |
| B7 | 双客户端 E2E（两浏览器页同房间断言一致） | e2e/ |

**验收**：双客户端 E2E 全绿（建房→加入→A 侦查→两页同线索事件；B 战斗→A 见 HP patch；断线重连补齐）；单人回归全绿。

### Phase C：同步增强与打磨（1-2 周）

| 步骤 | 内容 |
|---|---|
| C1 | 重连全链路：lastSeq 增量 + 快照兜底 + TTL 恢复 |
| C2 | 多端并发矩阵（同账号两设备 + 两账号同房间） |
| C3 | 旧存档导入/房间导出工具 |
| C4 | 房主控制完善 + 房间级结局共享 |
| C5 | 观战模式（P2）、性能压测（≤100 房间边界） |

**总工期：6-7 周**（A 2 + B 3 + C 1-2）。

---

## 八、测试策略

| 层 | 内容 |
|---|---|
| 单测 | rule-engine 137 用例随迁；RoomService（队列/seq/快照/门控/归属校验）；协议帧校验 |
| 双客户端 E2E（新增，B7 起） | 两 page：房间生命周期 / 共享消息 / 事件一致 / 工具链闭环（服务端执行）/ 重连恢复 |
| 单机 E2E（复用改造） | h5.journey.mjs：断言改为服务端广播事件（线索 +1、HP −2 的 state_patch） |
| test-agent（真实 LLM） | 43 用例回归（toolExecutor 移除，服务端直接驱动）；新增多角色合并消息场景 |
| 设备端 | 小程序自动化 + Android 模拟器回归 |
| CI | 现有流水线 + 双客户端 E2E（Phase B 起） |

**核心验证**：MOCK_AI 下双客户端 E2E 证明"权威在服务端"——两页对同一动作观察到完全相同事件序列；任何客户端本地状态与事件流冲突都会在断言中暴露。

---

## 九、风险与缓解（无兼容包袱版）

| 风险 | 影响 | 缓解 |
|---|---|---|
| 规则引擎搬运回归 | 单人规则行为变化 | 137 单测随迁 + MOCK E2E 工具链断言 + test-agent 回归 |
| 服务端有状态化内存/崩溃 | 房间状态丢失 | 节流快照落库 + TTL；崩溃按快照重建（丢失 ≤ 快照间隔） |
| LLM 并发瓶颈（多房间） | 排队 | 按房间队列 + 全局并发上限配置；扩展路径文档化 |
| LLM 选错角色（多角色卡） | 检定/伤害错人 | characterId 校验 + 缺省回退行动者 + 错误回喂修正 |
| 回合窗口叙事割裂 | 多行动回合混乱 | 窗口可调（0=严格排队）；合并消息带行动者标记 |
| 邀请码安全 | 陌生人乱入 | 6 位随机码 + owner 批准选项（P1）；成员上限校验 |
| 同角色多端冲突 | 一人两设备同时操作同一角色 | 事件流串行天然裁决；服务端校验动作归属 |

---

## 十、被否决的设计（反思记录）

1. **P2P/WebRTC**——小程序/NAT 不可靠；LLM/RAG 在服务端，无收益。
2. **客户端权威 + 广播**——无法防作弊、状态冲突无解、多端不同步。
3. **严格消息排队**——多人回合多次 LLM、割裂；窗口合并更符合 TRPG 回合制。
4. **CRDT/向量时钟**——服务端串行已保证全序，过度设计。
5. **规则引擎放 shared**——客户端纯渲染无需规则代码；放 server 更简单，测试随迁即可。
6. **executeTools 双轨**——无已部署客户端，双轨是纯负担，直接删除。
7. **离线模式（v1 未提，本版明确排除）**——在线是前提；离线为 P3 独立评估，不进本架构。
8. **Redis/外部队列先行**——目标规模单进程足够；触发条件式引入。

---

## 十一、总结

**单轨服务端权威架构**：状态、规则、骰子、KP 图循环全部收归服务端房间会话；客户端退化为"发动作 + 渲染事件流"的纯视图层；单人 = 单成员房间，多人 = 多成员房间，同一套代码路径。无已部署客户端意味着这次迁移零兼容负担，可以直接以目标形态落地：6-7 周三阶段（权威迁移 → 房间多人 → 同步打磨），每阶段以 MOCK + 双客户端 E2E 验收；70-75% 现有代码直接复用或仅搬迁，净新增集中在 RoomService 与房间协议。
