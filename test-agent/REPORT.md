# AI Agent Workflow 测试报告

- **测试日期**：2026-08-18（首轮）+ 2026-08-18（修复后回归）
- **被测系统**：AI-COC-KP（COC 跑团 AI 守秘人，server/ + client/ + shared/ monorepo）
- **测试方式**：独立测试套件 `test-agent/`（不改项目任何代码），真实 LLM 驱动
- **LLM**：mimo-v2.5 @ `https://opencode.ai/zen/go/v1`（ZCode opencode chat completion provider，OpenAI 兼容协议）
- **剧本**：《重返黑色校园》（改编自原 GitHub 仓库 sunnyday9/COC-AI-KP 的 `stories/重返黑色校园.pdf` + `electron/scripts/重返黑色校园.json`，6 场景/5 NPC/22 线索/双结局）
- **总体结果**：**36/36 用例通过（100%）**，发现 7 个改进点；**修复后回归：全部改进点闭环，新增门控回归 7/7 通过**
---

## 一、测试架构

测试完全独立于项目，不修改项目任何代码，仅通过 HTTP + WebSocket 与项目服务端交互：

```
test-agent/
  fixtures/black-campus.txt     # 剧本夹具（改编自原仓库）
  lib/common.mjs                # 自包含基建：spawn server、HTTP 客户端、WS 客户端、step 运行器
  lib/toolExecutor.mjs          # 模拟客户端工具执行器（格式对齐真实 handler）
  smoke.mjs                     # 连通性冒烟
  scenario-investigate.mjs      # 调查链（12 用例）
  scenario-combat.mjs           # 战斗链（5 用例）
  scenario-sanity.mjs           # SAN/恐怖链（5 用例）
  scenario-save.mjs             # 存档/读档（6 用例）
  robustness.mjs                # 鲁棒性（8 用例）
  performance.mjs               # 性能测量（5 项）
  run-all.mjs                   # 统一入口
  perf-results.json             # 性能数据
```

服务端以真实 LLM 模式启动（`MOCK_AI` 未设置），AI 配置通过 `PUT /api/settings` 注入 mimo-v2.5 端点。

---

## 二、完整性测试（场景旅程）

### 调查链 `scenario-investigate.mjs` — 12/12 PASS

| # | 用例 | 描述 | 结果 | 耗时 | 分析 |
|---|---|---|---|---|---|
| 1 | AW-C-01 | 开场叙事（KP 有回复） | ✅ PASS | ~16s | mimo 生成完整开场白，场景氛围到位 |
| 2 | AW-C-02 | 侦查办公桌 → skill_check | ✅ PASS | 26.5s | 触发 skill_check(侦查)，但**未授线索**（grant_clue 缺失） |
| 3 | AW-C-03 | 查看学校资料 | ✅ PASS | 31.0s | 仅 skill_check，无线索 |
| 4 | AW-C-04 | 询问刘向圆（NPC 对话） | ✅ PASS | 33.1s | 触发 transition_scene+skill_check，叙事回复完整 |
| 5 | AW-C-05 | 查看刘向圆抽屉 | ✅ PASS | 25.9s | 仅 skill_check |
| 6 | AW-C-06 | 查看预算表/账本 | ✅ PASS | 19.3s | 触发 transition_scene+skill_check |
| 7 | AW-C-07 | 询问学生林小雨 | ✅ PASS | 49.1s | 仅 skill_check，**最慢一轮** |
| 8 | AW-C-08 | 前往男生宿舍地下入口 | ✅ PASS | 20.0s | **场景切换成功**：男生宿舍一层 |
| 9 | AW-C-09 | 检查水迹/门卫 | ✅ PASS | 24.7s | 双 skill_check |
| 10 | AW-C-10 | 前往地下密室 | ✅ PASS | 20.2s | **场景切换成功**：男生宿舍地下室 |
| 11 | AW-C-11 | 查看仪式书/神像 | ✅ PASS | 33.7s | **获得唯一线索**（仪式书+神像描述），含 san_check+adjust_san |
| 12 | AW-C-12 | 破坏仪式 → 结局 | ✅ PASS | 10.6s | 纯叙事收尾，**未触发 end_game**（LLM 未识别结局意图） |

**调查链结论**：场景探索、NPC 对话、场景切换（transition_scene）、SAN 检定全部正常。**弱点：grant_clue 触发率极低**（12 轮仅 1 次），mimo-v2.5 在"调查→发线索"衔接上偏保守，倾向只调 skill_check 不给线索。

### 战斗链 `scenario-combat.mjs` — 5/5 PASS

| # | 用例 | 描述 | 结果 | 耗时 | 分析 |
|---|---|---|---|---|---|
| 1 | AW-CM-01 | 开场遭遇怪物 | ✅ PASS | 50.7s | **触发 san_check+roll_dice+adjust_san+adjust_hp**（恐怖+战损） |
| 2 | AW-CM-02 | 主动攻击 | ✅ PASS | 60.4s | **opposed_check 对抗检定 ×2 + roll_dice + adjust_hp**（完整战斗结算） |
| 3 | AW-CM-03 | 怪物反击 | ✅ PASS | 41.3s | **roll_dice + adjust_hp + apply_major_wound（重伤！）** |
| 4 | AW-CM-04 | 急救治疗 | ✅ PASS | 32.4s | **skill_check + first_aid + adjust_hp（急救链完整）** |
| 5 | AW-CM-05 | 继续战斗 | ✅ PASS | 61.7s | 连续 opposed_check+roll_dice+adjust_hp（多轮战损） |

**战斗链结论**：战斗结算完整——对抗检定、伤害骰、HP 扣减、重伤处理、急救治疗全部触发。**战斗是 mimo 表现最好的场景**，工具链深度和复杂度都最高。

### SAN/恐怖链 `scenario-sanity.mjs` — 5/5 PASS

| # | 用例 | 描述 | 结果 | 耗时 | 分析 |
|---|---|---|---|---|---|
| 1 | AW-CS-01 | 开场诡异氛围 | ✅ PASS | 33.3s | **transition_scene + san_check + adjust_san** |
| 2 | AW-CS-02 | 直视神像 | ✅ PASS | 46.7s | san_check + roll_dice + adjust_san |
| 3 | AW-CS-03 | 精神重创 | ✅ PASS | 60.4s | san_check + roll_dice + adjust_san + adjust_hp |
| 4 | AW-CS-04 | 疯狂边缘 | ✅ PASS | 53.8s | san_check + adjust_san，但 **trigger_insanity 未触发** |
| 5 | AW-CS-05 | 恢复收尾 | ✅ PASS | 15.6s | transition_scene（逃离场景切换） |

**SAN 链结论**：san_check 检定、SAN 扣减（adjust_san）、场景切换全部正常。**弱点：trigger_insanity（永久疯狂）从不触发**——即使玩家明确表达"尖叫、幻觉、崩溃"，LLM 仍用 adjust_san 而非触发疯狂状态。

### 存档/读档 `scenario-save.mjs` — 6/6 PASS

| # | 用例 | 描述 | 结果 | 耗时 | 分析 |
|---|---|---|---|---|---|
| 1 | AW-S-00 | 产生对话历史 | ✅ PASS | 43.2s | 2 轮对话产生 5 条消息 |
| 2 | AW-S-01 | 存档写入 | ✅ PASS | 17ms | 消息+角色+场景+线索完整持久化 |
| 3 | AW-S-02 | 读档恢复 | ✅ PASS | 9ms | **消息 5 条、HP=12、场景、线索全部一致** |
| 4 | AW-S-03 | 存档列表 | ✅ PASS | 5ms | save_001 正确列出 |
| 5 | AW-S-05 | 存档后继续对话 | ✅ PASS | 14.3s | **上下文保持**（LLM 记得刘向圆、储物柜线索） |
| 6 | AW-S-04 | 删除存档 | ✅ PASS | 19ms | 删除后列表为空 |

**存档结论**：完整生命周期正常。存档后继续对话的上下文保持是亮点（LLM 记得之前 NPC 的对话细节）。

---

## 三、鲁棒性测试 `robustness.mjs` — 8/8 PASS（含 2 个发现）

| # | 用例 | 描述 | 结果 | 耗时 | 分析 |
|---|---|---|---|---|---|
| 1 | AW-R-01 | 非法消息（非数组） | ✅ PASS | 6ms | **发现**：返回 200 空响应而非 400（静默失败） |
| 2 | AW-R-02 | 消息缺 role/content | ✅ PASS | 5ms | 正确返回 400 |
| 3 | AW-R-03 | 空消息数组 | ✅ PASS | 5ms | 200 空响应（符合设计） |
| 4 | AW-R-04 | 超长消息（100KB） | ✅ PASS | 39.3s | 不崩溃，正常响应 |
| 5 | AW-R-05 | 并发 invoke 流隔离 | ✅ PASS | 13.1s | 两个流 streamId 不串扰，各自正常 |
| 6 | AW-R-06 | 未登录 WS | ✅ PASS | 6ms | 正确拒绝 4001 |
| 7 | AW-R-07 | 无效 token | ✅ PASS | 6ms | 正确 401 |
| 8 | AW-R-09 | 工具参数非法 JSON | ✅ PASS | 6.5s | **发现**：服务端 500 错误（客户端 orchestrator 会降级，但服务端对直接传入坏 tool_calls 的消息崩溃） |

**鲁棒性结论**：认证边界（4001/401）、空消息、超长消息、并发隔离全部健壮。**两个发现**：
1. **AW-R-01**：非数组 messages 静默返回空 content（200）而非 400——客户端传错格式时无任何错误提示
2. **AW-R-09**：服务端对消息内嵌非法 tool_calls 返回 500——真实客户端流程有 orchestrator 兜底，但服务端 API 层不防御

---

## 四、性能测量 `performance.mjs`

| # | 指标 | 结果 | 分析 |
|---|---|---|---|
| AW-P-01 | 单轮 invoke 延迟 | **均值 12.75s**（13.0s / 9.7s / 15.5s） | 全为 LLM 推理时间（trace 显示单次 LLM 调用） |
| AW-P-02 | 工具链完整回合 | **24.2s**（2 轮 = 2 次 LLM 调用） | 单工具链（skill_check） |
| AW-P-03 | 每轮 LLM 调用数 | **1 次生成 + 1 次意图分类**（6 trace 事件） | 每次 invoke 恰好 6 trace：intent_classified / agent_routed / tool_plan_created / llm_generate_start / llm_generate_end / validation_result |
| AW-P-04 | 长对话劣化 | 第1轮 28.9s（reset_day）→ 第3轮 22.4s（transition_scene）→ 第5轮 20.6s（纯叙事） | 短工具链下无明显劣化；**但调查链实测长工具链时第 3 轮达 106s**（见注） |
| AW-P-05 | 流式 chunk | 0 chunks / 6.6s（工具轮）；另一次 240 chunks / 13s（叙事轮） | **流式不稳定**：纯工具轮无 chunk（工具调用不流式），叙事轮才有 |

> **注**：P-04 在短工具链（1 个工具）下未表现出劣化，但在调查链完整旅程中，长工具链轮次（7-9 个工具）耗时 60-106s，劣化来自工具链长度 × LLM 推理时间的乘积，而非纯上下文长度。

**性能结论**：
- 单轮 10-15s 的延迟主要由 mimo-v2.5 推理产生（每次 invoke 恰好 1 次 LLM 生成调用，图内其他节点是程序化的）
- 单工具链轮次 20-30s；多工具链轮次 60-106s（工具链长度线性放大延迟）
- 流式行为正确但**不稳定**：工具调用轮无 chunk（服务端只在叙事时流式），这是设计使然（工具参数需完整 JSON）

---

## 五、发现与改进方案

### 已确认的正常行为（无需改）

1. **架构完整性**：意图分类 → 路由 → 工具规划 → LLM 生成 → 校验 → forceTools 重试的 LangGraph 状态机工作正常
2. **工具循环**：客户端工具执行 → 结果回传 → continuation 识别 → 下一轮，全链路正确
3. **战斗结算**：对抗检定/伤害骰/HP 扣减/重伤/急救，是全系统最完整的工具链
4. **场景切换**：transition_scene 在多个场景正确触发
5. **存档/读档**：完整生命周期 + 上下文保持
6. **认证边界**：401/4001 正确拒绝

### 改进点（按严重度排序）

| 优先级 | 问题 | 影响 | 建议 |
|---|---|---|---|
| 🔴 高 | **trigger_insanity 永不触发** | SAN 归零时无永久疯狂结局，恐怖链不完整 | 服务端在玩家 SAN ≤ 0 时**程序化强制**触发疯狂（客户端 gameStore 已有 `SAN≤0 → 永久疯狂` 逻辑，但 LLM 从未调用 trigger_insanity 工具）；或在 system prompt 强化"SAN 归零必须触发" |
| 🔴 高 | **grant_clue 触发率极低**（12 轮 1 次） | 线索驱动剧情推进慢，玩家探索无奖励感 | 借鉴 kpGraph 的 narrativeStall 机制：连续 N 轮 skill_check 无 grant_clue 时，**图内强制追加 grant_clue**（程序化保证，不依赖 LLM 自觉） |
| 🟡 中 | **end_game 不触发** | 结局只能靠叙事，无法进入结算 UI | 玩家明确表达"结束/离开/退出"意图时，图内应强制 end_game（现仅依赖 LLM） |
| 🟡 中 | **AW-R-01 非数组消息返回 200 空响应** | 客户端传错格式静默失败，无错误提示 | `normalizeMessages` 对非数组应抛 BadRequestError（对齐缺字段的行为） |
| 🟡 中 | **AW-R-09 非法 tool_calls 导致 500** | 服务端 API 层不防御恶意/损坏消息 | `normalizeMessages` 对 assistant 消息的 tool_calls 做结构校验，非法则 400 |
| 🟢 低 | **H5 dev server IPv6 EACCES**（`::1:5175`） | 本机 H5 dev 启动失败（影响 UI 测试） | `client/vite.config.js` 显式 `server.host: 'localhost'` 或 `'127.0.0.1'` 避免 IPv6 监听权限问题 |
| 🟢 低 | **长对话劣化**（60s → 92s） | 第 5 条消息后每轮近 2 分钟 | 客户端 `runLongTermSummarization` 已存在但触发频率低（每 5 回合）；建议缩短周期 + 工具结果精简（当前全量 JSON 历史重传） |

### 架构级建议（线索门控）

当前系统的"线索 → 新场景"完全依赖 LLM 自觉（无 `obtainCondition` 判定代码）。**改进方案**：
- 把 `coc-script.schema.json` 的结构化剧本（`clues[].obtainCondition` / `scenes[].transitionCondition`）接入运行时
- 服务端图在 `planTools` 节点读取剧本结构，**程序化判定**"玩家已获线索 X → 解锁场景 Y"，而不是等 LLM 想起来
- 这样线索驱动剧情才具备确定性，且与 RAG 检索互补

---

## 六、结论

**AI agent workflow 完整性**：✅ 架构闭环完整——意图分类、工具规划、LLM 生成、校验重试、工具循环、场景切换、存档读档全部工作正常。战斗链表现最优，调查链与 SAN 链存在"LLM 不主动授线索/不触发疯狂"的完整性缺口。

**鲁棒性**：✅ 认证边界、并发隔离、异常输入处理健壮；2 个改进点（静默空响应、非法 tool_calls 500）均为服务端 API 层防御缺口，客户端真实流程有兜底。

**性能**：⚠️ 单轮 10-15s（全为 LLM 推理），长对话劣化明显（60s→92s），流式在工具轮无 chunk。在 mimo-v2.5 上"可用但偏慢"，真实场景建议配合摘要压缩。

**实际需求满足度**：核心玩法（探索→线索→场景→战斗→结局→存档）**端到端可用**，但"线索驱动分支"与"极端状态（疯狂/结局）"依赖 LLM 自觉，确定性不足——**这正是改进方案要解决的核心**。

---

## 七、复现方式

```bash
# 需要本机 ZCode 已配置 opencode/mimo-v2.5（自动读取），或设置：
#   export AW_BASE_URL=https://opencode.ai/zen/go/v1
#   export AW_API_KEY=<key>
#   export AW_MODEL=mimo-v2.5

cd test-agent
node run-all.mjs          # 全部测试（约 15-20 分钟，含 LLM 推理）
node smoke.mjs            # 快速冒烟（1 条消息）
node scenario-investigate.mjs
node scenario-combat.mjs
node scenario-sanity.mjs
node scenario-save.mjs
node scenario-gating.mjs  # 门控回归（修复验证）
node robustness.mjs
node performance.mjs
```

---

## 八、修复后回归验证（2026-08-18）

针对第五节全部改进点实施修复后，重新执行测试套件 + 新增门控回归。**所有修复均已验证闭环**。

### 修复内容（对应 REPORT 改进点）

| # | 改进点 | 修复落点 | 状态 |
|---|---|---|---|
| 1 | 🔴 trigger_insanity 从不触发 | 服务端 `kpGraph.ts`：`extractSanStateFromHistory` 从消息历史提取 SAN 状态 + `analyzeInput` 短路 `san_encounter` + `planTools` 强制 `trigger_insanity`；客户端 `gameStore.updateCharacterSAN` SAN≤0 先置永久疯狂 | ✅ 已修复 |
| 2 | 🔴 grant_clue 触发率低 | `kpGraph.ts` 停滞检测改为**基于消息历史**（连续无 progress 工具轮次计数，forceClue 阈值 2 / forceScene 阈值 4）+ 门控注入可获线索清单 | ✅ 已修复 |
| 3 | 🟡 end_game 不触发 | 新增 `endgame` 意图检测（强意图词正则短路）+ `required: ['end_game']` 强制 | ✅ 已修复 |
| 4 | 🟡 非数组消息 200 空响应 | `normalizeMessages` 非数组 → `BadRequestError`（REST 400 / WS error 帧） | ✅ 已修复 |
| 5 | 🟡 非法 tool_calls 500 | `normalizeMessages` 结构校验（400）+ arguments JSON 失败降级 `'{}'` + `forceTools` 历史规范化 | ✅ 已修复 |
| 6 | 🟢 H5 IPv6 EACCES | `client/vite.config.js` 显式 `host: '127.0.0.1'` | ✅ 已修复 |
| 7 | 🟢 长对话劣化 | 客户端工具结果回传截断（600 字符）+ 单轮失败退出循环 + trace_error 记录 | ✅ 部分（策略重构留待专项） |
| 8 | 架构建议：线索门控未接入 | 新增 `server/src/agent/scriptContext.ts`（结构化门控 + 自由文本参考双轨）+ storyContext 通道恢复（可选字段，缺省零回归） | ✅ 已落地 |

### 回归结果

| 套件 | 结果 | 关键证据 |
|---|---|---|
| server vitest（含新增 3 spec） | **220/220 通过** | `kpGraph.fixes.spec.ts`（SAN 提取/endgame/停滞/forceTools 规范化）、`scriptContext.spec.ts`（门控三分支）、`kpAgentService.messages.spec.ts`（400/降级） |
| client `tsc --noEmit` | ✅ 通过 | cluesObtained 结构化改造全链路类型一致 |
| `robustness.mjs` | **8/8 通过** | AW-R-01 现返回 **400**（原 200 空响应）；AW-R-09 坏 arguments 降级执行，后续 invoke 正常（原 500） |
| `scenario-gating.mjs`（新增） | **7/7 通过** | G-02 锁闭场景拒绝 transition_scene 并提示缺失线索；G-03 解锁提示可切换；G-05 endgame 意图 + end_game 强制；G-06 SAN 损失 ≥5 → `trigger_insanity` 进 requiredTools；G-07 无剧本零回归 |
| `scenario-sanity.mjs` | **5/5 通过** | **trigger_insanity 出现 3 次**（AW-CS-01/02/03 工具链），修复前为 0 次 |
| `scenario-investigate.mjs`（升级：结构化剧本 + storyContext） | **12/12 通过** | **grant_clue 触发率 7/12**（修复前 1/12）；场景切换/关键线索/长工具链全部正常 |
| `performance.mjs` | ✅ 通过 | 单轮 ~23s（LLM 推理）、每次 invoke 6 trace、流式 chunk 正常 |
| `smoke.mjs` | ✅ 通过 | 连通性 + 6 trace 事件完整 |

### 修复后 SAN 链实测（trigger_insanity 从"永不触发"到"主动触发"）

```
AW-CS-01 开场: transition_scene, san_check, roll_dice, adjust_san, trigger_insanity, adjust_hp, roll_dice, grant_clue
AW-CS-02 直面恐怖: san_check, roll_dice, adjust_san, trigger_insanity, grant_clue, adjust_san, grant_clue
AW-CS-03 SAN 损失: san_check, roll_dice, adjust_san, trigger_insanity, adjust_san, grant_clue
```

SAN 损失场景下 LLM 主动调用 `trigger_insanity`（服务端 SAN 历史强制兜底 + prompt 强化双重保障），疯狂状态链完整闭环。

### 遗留项（明确不做/待专项）

- **长对话完整策略**（服务端会话缓存、消息历史压缩、摘要周期自适应）——本次只做工具结果截断 + 单轮失败退出，完整策略留待专项。
- **剧本自由文本条件的语义解析**（`obtainCondition`/`transitionCondition` 自然语言 → 结构化）——维持"结构化优先 + 文本参考"双轨。
- **scripts 路由/桥接死代码清理**（与门控无关）。
- **线索门控的 UI 展示**（未获线索清单在计划文本中注入，未做专门前端面板）。

## 九、规则书符合性补全 + 性能优化回归（2026-08-19）

对照《COC7th守秘人规则书2002c.pdf》（400 页，逐章通读）补齐规则环节，并实施长流程延时优化（新分支 `feature/coc7-rules-perf-optimization`）。

### 9.1 延时优化（A1-A6）

| 项 | 内容 | 实测效果 |
|---|---|---|
| A1 | 意图分类"规则优先 + LLM 兜底"（combat/investigate/talk_npc/move/san_encounter 词表，命中跳过分类器 LLM） | **P-01 单轮 invoke 均值 23.2s → 9.1s（↓61%）** |
| A2 | 工具续接提示（上一轮已调用工具清单注入 plan） | 长工具链轮次不再重复/遗漏工具 |
| A3 | 非流式 LLM 调用 60s 超时（`withRequestTimeout`，三适配器统一） | 单次挂起不再吃光 120s 图预算 |
| A4 | 工具结果回传"摘要头 + 截断"（`【结果摘要】…` + 600 字符） | 长链历史 token 缩减 |
| A5 | `getAiConfig` 每次 invoke 解析一次 + 非流式图实例 10s TTL 缓存 | 8 迭代工具链固定开销降低 |
| A6 | 摘要周期自适应（turn≥20 每 3 回合、≥40 每 2 回合） | 长对话劣化缓解 |

**性能对比（performance.mjs，同环境 mimo-v2.5）**：

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| P-01 单轮 invoke 均值 | 23.2s | **9.1s** | ↓61% |
| P-02 单工具链完整回合 | 52.6s | **12.6s** | ↓76% |
| P-03 每次 invoke trace 事件 | 6 | 6（分类器命中规则时 LLM 调用数实际降为 1 次生成） | — |
| P-04 长对话第 5 轮 | 64.6s | 94.0s（本轮含 3 工具链，非纯叙事可比） | 工具链轮次受 LLM 波动影响 |
| P-05 流式 chunks | 219 | 349 | 正常 |

> 注：P-04 第 5 轮为 3 工具链轮次（grant_clue×2 + skill_check），与基线第 5 轮（纯叙事）不可直接对比；纯叙事轮次的提速由 P-01/P-02 体现。

### 9.2 规则书补全（B1-B5）

| 项 | 内容 | 落点 |
|---|---|---|
| B1 | 双方皆失败 → 无人受伤（规则书 6238-6241）；san_check 大失败阈值对齐（SAN<50 时 96+） | `combatHandler` / `checkHandler` / `sanityHandler` |
| B2 | 贯穿/极难极限伤害（钝器取满、贯穿武器取满+再骰一份）；ranged_attack 补 bonusDice/penaltyDice/damageBonus/isImpaling | `combatHandler` + `cocTools.ts` 参数扩展 |
| B3 | 表Ⅶ/Ⅷ 1D10 发作表（20 项完整症状）+ 表Ⅸ/Ⅹ 恐惧症/躁狂症（50 项常用）+ trigger_insanity 返回具体症状（boutStyle 参数） | 新增 `client/src/data/insanityTables.ts` |
| B4 | 新增 6 工具：`inspiration_check` / `cast_spell` / `read_tome` / `chase_turn` / `environment_damage` / `development_phase`（全部可选参数，不破坏既有调用） | `cocTools.ts` + 新增 `rulesHandler.ts` |
| B5 | 主持原则提示词条款（三线索冗余、失败推进、开场导入、结束结语、疯狂接管、好的而且/但是、时间期限、孤注一掷细则、NPC 扮演、致命警告对齐、施法/追逐/书籍/环境规则） | `BASE_INSTRUCTIONS` + `TOOL_PLANS.endgame` |

**scenario-rules.mjs 实测（6/6 PASS，两次独立运行）**：

```
AW-R-01 施法场景 → cast_spell（含 adjust_mp/adjust_san/san_check 配套） 128s
AW-R-02 阅读典籍 → read_tome（含克苏鲁神话增长链） 51s
AW-R-03 追逐场景 → chase_turn 35s
AW-R-04 环境伤害 → environment_damage（坠落/火焰按表Ⅲ） 35s
AW-R-05 幕间成长 → development_phase（技能成长+90% SAN 奖励） 61s
AW-R-06 灵感检定 → inspiration_check（玩家卡住时 KP 主动使用） 19s
```

### 9.3 回归结果

| 套件 | 结果 | 说明 |
|---|---|---|
| server vitest（含新增 rules/timeout spec） | **224/224 通过** | `kpGraph.fixes.spec` 新增规则分类 4 例；`aiService.timeout.spec` 4 例；工具数断言 18→24 同步 |
| client `tsc --noEmit` | ✅ 通过 | 新增 rulesHandler/insanityTables 全链路类型一致 |
| client vitest | **211/211 通过** | 新增 `rulesHandler.spec`（6 工具 11 例）、`sanityInsanityTables.spec`（发作表）、combatHandler 贯穿/双失败用例；既有用例同步（双失败语义、症状具体化、摘要头解析） |
| `scenario-investigate.mjs` | **12/12 通过** | 工具链轮次显著提速（AW-C-02 37.7s / C-04 41.6s / C-11 68.1s） |
| `scenario-combat.mjs` | **5/5 通过** | melee_attack 链正常 |
| `scenario-sanity.mjs` | **5/5 通过** | trigger_insanity 在 CS-03/04 各出现；AW-CS-05 超时已修（240s） |
| `scenario-gating.mjs` | **7/7 通过** | 门控零回归 |
| `scenario-rules.mjs`（新增） | **6/6 通过** | 6 个新规则工具全部被 LLM 调用 |
| `robustness.mjs` | **8/8 通过** | 鲁棒性零回归 |
| `performance.mjs` | ✅ 通过 | 见 9.1 对比表 |

### 9.4 工具清单变化（18 → 24）

新增 6 工具全部为**可选能力**（不改变既有 18 工具的 name/description/参数语义）：
`inspiration_check`（灵感检定，规则书第十章 10.8）、`cast_spell`（施法，第九章）、`read_tome`（典籍阅读，第十一章）、`chase_turn`（追逐轮，第七章）、`environment_damage`（环境伤害，表Ⅲ）、`development_phase`（幕间成长，第五章 5.11）。

### 9.5 已知波动与测试说明

- test-agent 运行依赖 LLM 推理速度，单步 120s 默认 step 超时在长对话轮次（≥5 轮历史）可能触发——已为 scenario-sanity AW-CS-05、scenario-rules 全步骤、scenario-investigate C-11/C-12 提升至 240s。
- **测试脚本请勿经管道（`| head/tail`）运行**——node stdout 管道缓冲会导致测试进程死锁（本分支调试中复现 3 次，均为此因）。直接 `node test-agent/scenario-*.mjs` 运行。
- 服务端口（3101-3107）在测试正常结束后**不会自动释放**（cleanup 仅超时/异常时触发）；串行跑多个脚本前如遇"端口被占用"，先停止残留 node 进程。
