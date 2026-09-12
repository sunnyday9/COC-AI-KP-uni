# 实验对比：剧本档案 + Agentic Search vs embedding RAG

> 分支 `feature/kp-dossier-workflow` · 2026-09-07 · 实验性——不落 ADR，结论待用户裁决后决定去留
> 相关：`.scratch/rag-simplification-grill-state.md`（2026-09-06 暂停的 RAG 简化 grilling，本实验是其 Phase 2 方向的一次实现尝试）

## 背景与动机

用户提出：本项目每场游戏只有 **1 篇剧本** 需要被 LLM 读取记忆（2.8万~17万字符），不是 RAG 典型的"大量文档检索"场景；每回合用玩家消息当 query 做 embedding 检索，本质是相关性猜测而非事实查证。侦查坐实（证据见下）：TF-IDF 写而不读、无 embedder 时情报块静默变空、会话图存储死代码、e2e 从不断言情报块正文。

SFT 已放弃（#41 CLOSED 维持 BYOK）→ 训练侧约束解除 → 本实验按纯运行时设计，实现两条可切换 workflow 并 A/B 对比。

## 两条 workflow 架构

| | **rag（现状，对照基准）** | **dossier（本实验）** |
|---|---|---|
| 知识准备 | 客户端切块 → embedding 索引（+GraphRAG 实体图，默认开但从未成功出图） | 服务端读全文 → LLM 一次预生成**结构化档案**（场景/线索/NPC + 门控 + 场景原文），落 `DOSSIER_DATA_DIR` |
| 每回合知识注入 | 玩家消息当 query → 稠密检索 top8 chunk → `## 故事情报` 块（无 embedding → **静默空**） | 按当前场景注入**档案场景块**（现场描述/在场NPC/可获线索/行动引导）→ `## 当前场景档案` 块 |
| 查证能力 | 无（模型不能追问剧本） | **agentic**：scene_list / scene_dossier / lexical_search 三只读工具，模型按需查证 |
| 场景门控 | 仅结构化 JSON 剧本生效（真实 PDF/txt 无效） | 任意格式剧本生效（档案即结构层，`scriptContext` 先查档案） |
| 开关 | 房间默认 | 房间级 `workflow:'dossier'`（solo/多人均可） |

**双轨并存**：rag workflow 代码路径逐字节未动（对照纯净）；dossier 全新增模块（`rag/dossier/*`）+ workflow 开关（RoomSnapshot 持久化）+ 查证工具（不进 COC_KP_TOOLS，dossier 房下发时拼接）。

## 改动清单（分支 7 commit：fec1ae1 → 5c2467d）

- **P2 fec1ae1** dossier 档案服务：LLM 分批抽取→merge→落盘；schema = ScriptContext 超集（sceneText/hooks/requiredClues）；mock 下确定性 JSON（3场景/3线索/2NPC）
- **P3 bde3c28** workflow 双轨开关（RoomSnapshot 三处同步 + 建房参数）+ fetchRagContext 分派 + prompt 变体（`## 当前场景档案` vs `## 故事情报`）+ scriptContext 先查档案
- **P4 eb34b2f** agentic 查证工具：shared 定义 + buildInvokeLLM 可选 tools + kpTurnService 特判执行（绕过同步 rule-engine）+ roomService.buildStoryLookup 注入
- **P5 4024779+435554c** dossier REST（generate/list；读删不设 HTTP 端点——非游戏路径）+ e2e dossier.journey 7/7 绿
- **P6 a379dc7+5c2467d** A/B harness + 路由 assertId 统一 400
- 全量 server 单测 **479 绿**（基线 466 + 13 新增）零回归；dossier journey 7/7 绿；rag rooms/multiroom journey 未跑（本分支未动 rag 路径，理论零影响）

## 修复的真实 bug（dossier 房特有，真实 LLM 同样会触发）

1. **查证工具不算叙事进展 → 被 stall 机制强制授线索**：`STALL_PROGRESS_TOOLS` 原只含 grant_clue/transition_scene，narrative 轮查证（无叙事产出）2 轮后 validate force grant_clue。修：查证工具计入进展工具。
2. **查证词被判 investigate → 强制 skill_check 链**：classifier 加查证词→narrative 映射（mock + kpGraph rule-first 双侧一致）。

## Mock A/B 数据（deterministic，零成本）

同 demo-story、同一 6 条输入脚本（侦查/问NPC/查花瓶/撬锁/查卷宗/查证地点）驱动 rag 房 vs dossier 房：

| 指标 | rag 房 | dossier 房 |
|---|---|---|
| 每回合知识注入 | **0 tok**（mock 无 embedding → 情报块恒空） | 首场景档案块 ≈ **2048 tok**（6 回合 + opening 全程注入） |
| 6 回合 KP 回复 | 119 tok（mock 固定文案） | 119 tok（mock 固定文案） |
| 查证工具调用 | 无（无此能力） | scene_list → scene_dossier 链（journey 断言） |
| 回合完整性 | 情报块缺失（KP 无剧本事实可依） | 档案块每回合在场（KP 有场景原文） |

**mock 数据直接坐实用户质疑**：rag workflow 在无 embedding 配置（或 MOCK/e2e）下，`fetchRagContext` 恒返回 '' → `## 故事情报` 块整块消失，KP 每回合**零剧本知识**——而这是 e2e/训练一路跑过来的"默认形态"。

## 真实 LLM 对局：**受阻，未完成**（待 BYOK 端点）

可用端点实测：
- **mimo**（opencode.ai/zen/go/v1，zcode provider）：400 需 `x-opencode-session` 头——本项目适配器不支持自定义头 → 不可用
- **问财 IWENCAI**：401（key/端点失配）
- **baishan edgefn**（api.edgefn.net/v1, DeepSeek-V4-Flash）：单请求 200 可用，但**连续请求 429 限流** → 无法驱动整局

**复跑方法**（harness 已就绪）：
```bash
AB_AI_BASE_URL=<openai 兼容端点> AB_AI_API_KEY=<key> AB_AI_MODEL=<model> \
MOCK_AI=0 node scripts/eval/ab-compare.mjs --out=training/eval/reports/ab-real-<ts>.json
```
真实模式下：rag 索引触发服务端 embedding（内置 text2vec 本地模型自动下载至隔离 MODELS_DIR）；dossier 生成调真实 LLM；回合 wire 采样自动落库（rag_context/工具调用分布真实可比）。

## 观察与待裁决点

**dossier 优势（代码层已证实）**：
1. 每回合知识注入**确定性在场**（不依赖 embedding 可用性）——消灭"情报块静默空"整类问题
2. KP 可**显式查证**（scene_list/scene_dossier/lexical_search）——模型决定何时查、查什么，不再暗箱猜
3. 场景门控/线索依赖对**任意格式剧本**生效（PDF 剧本首次获得结构化门控）
4. 索引期成本一次（demo-story 1 次 LLM 调用），回合零 embedding 推理

**代价/风险**：
1. 档案质量依赖生成 LLM（需人工抽检；真实抽取对长剧本 17万字符 = 分批 ~17 次调用）
2. 大剧本档案块可能 > 单场景注入预算（需 sceneText 截断策略，本次 demo 未暴露）
3. 真实对局质量（叙事自然度/查证触发频率/事实一致性）**未验证**——mock 只证链路通

**遗留缺口**（实验分支已知，报告后补）：
- 客户端 UI 无 dossier 入口（scripts 生成按钮 / room workflow radio）——对局经 REST/WS 直连驱动
- 场景切换（transition_scene）后档案块跟随当前场景注入——已实现（按 this.scene 查档案）但 mock journey 未覆盖跨场景回合
- dossier 档案删除/重生成端点未设（非游戏路径）

## 结论

代码层证据支持用户判断：**单剧本场景下，dossier + agentic 查证是比 embedding RAG 更贴合的结构**——至少消除了"情报块静默空"与"相关性猜测"两个实质缺陷，且为 PDF 剧本补上了结构化门控。**真实 LLM 质量对比待端点就绪后补跑**（harness 一条命令）。去留裁决：维持双轨 / 档案线转正（rag 线退役）/ 维持现状，由用户基于真实对局数据决定。
