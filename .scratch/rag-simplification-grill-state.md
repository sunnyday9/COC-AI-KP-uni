# RAG 简化 grilling 状态存档（2026-09-06，暂停待续）

> 用户暂停 grilling 转入 #41。本文件只存状态，不是决策记录——Round 2 未获用户确认，不落 ADR。

---

# ═══ 第二轮 grilling（2026-09-11，dossier 为主 + 标准 RAG 兜底）═══

> 用户新方向：「dossier 作为 LLM 首先查看的依据/框架/场景/逻辑/线索等关键性内容，
> 对于细致性描写，可以使用 RAG 来做补充兜底（放弃 graph rag，就用标准的 RAG：
> embedding→recursive semantic chunking→query→top10→rerank top3→respond）」
> 当前分支 feature/kp-dossier-workflow（P1–P27 已落地：档案 + verify_original + 服务端预取）。

## Round 1（已收敛，2026-09-11 用户「全部按推荐」）

- Q1 触发形态 = **(a) 每回合固定检索注入 rerank top3**；P27 预取降级为可选深挖路径（存废见 Round 2 Q5'）。
- Q2 分工契约 = **RAG 只供纹理/原文原话，事实以档案为准**；跨场景块须标注「未来场景片段，仅作描写素材、不得揭示」。
- Q3 分块落点 = **搬到服务端**：token/字符计数 + 用 dossier `sceneAnchors` 给块打场景归属（顺手修 PDF scene 过滤空转）。
- Q4 rerank = **本地 cross-encoder**（`onnx-community/bge-reranker-base-ONNX` + `dtype:'q8'`，279MB；必须 sigmoid 取 logit，禁用 pipeline text-classification）。
- Q5 GraphRAG = **删干净** + **保留 rag workflow 但改用标准 RAG 作对照**。

## Round 2（已收敛，2026-09-11）

- Q6 query 构造 = **场景名 + 玩家合并发言（去花名册前缀）**，并**允许适当改写**（改写形态见 Round 3 Q12）。
- Q7 注入形态 = **独立小节 `## 原文片段（检索补充·仅作描写素材）`**，≤3 块 / ≤1.6k 字符，与档案块高重叠块剔除。
- Q8 剧透严格度 = **折中 (b)**：场景内优先 → 无归属次之 → 跨场景 ≤1 条带「未来场景片段」前缀；
  与 `truths[].revealScene` 锚点窗口相交的块**直接丢弃**。
- Q9 分块规格 = **递归切分（标题→段落→句末）+ 目标 ~800 字符 / 重叠 ~100 + 场景元数据 + 字符偏移**；
  存量索引不迁移（按新管线重建）。
- Q10 P27 预取 = **保留**（事实层深挖，与纹理层不冲突；M1 后按数据复议存废）。
- Q11 验收 = **事实问答延续 5 问 judge + 新增纹理 rubric（1–5）+ 延迟不得超过 rag 房**；2–3 篇 A/B。

## Round 3（已发出，待用户回答）

- Q12 query 改写形态（推荐：规则清洗 + 检索低分时一次 LLM 改写重检，有界成本）
- Q13 场景归属在索引期还是查询期（推荐：索引期存字符偏移，查询期用 gaps 锚点解析场景）
- Q14 API 断代与旧链路删除范围（推荐：干净断代 —— /api/rag/index 改为仅 scriptId，服务端自读自切；删客户端切块器 + graph 全链）
- Q15 配置面（推荐：M1 只留总开关，参数硬编默认；配置 UI 后置）
- Q16 rerank 模型下载时机与降级（推荐：索引时下载 + 缺失时降级为纯余弦 top3 + 测试注入缝）
- Q17 ADR/词条（推荐：ADR-0007 新写「档案为主 + 标准 RAG 补充」，取代旧「双阶段路线」欠账；CONTEXT.md 补 3 词条）

## 已核实事实（本轮侦查，可复用于 ADR）

**现状**（文件:行号见会话）：
- 分块只在客户端（`client/src/services/storyService.ts` textToChunks 800/重叠 100 **按 UTF-16 字符非 token**，
  两级切分）；服务端 0 行切块代码。
- 全仓 **0 rerank**；排序 = 纯余弦 topK 直接切（`vectorStore.ts:461-475`），无阈值/去重/MMR。
- 检索链：`roomService.fetchRagContext(topK:8)` → `ragService.context` → `graphRag.buildContextWithGraph`
  → `vectorStore.queryChunks`（sceneId 硬过滤但 PDF 无 scene_id → 退化为不过滤）。
- GraphRAG：索引期 LLM 建图+社区摘要（最多 5 社区/摘要截 500 字）；查询期 2 跳扩展**无数量上限**
  （`graphRag.ts:127-130`）；`useGraphRAG` 默认 true。
- 本地 embedding 正常：text2vec-base-chinese-sentence 768 维，实测冷启 1.4s，向量真实（A/B 每回合
  注入量随 query 变化）；`server/data/rag/12/…json` 那个 170 块 0 向量是 mock 遗留，非活路径 bug。

**rerank 选型核查（已完结，可直用）**：
- **首选 `onnx-community/bge-reranker-base-ONNX` + `{dtype:'q8'}`（279MB）**：xlm-roberta，
  transformers.js 3.8.1 原生支持，无外挂数据文件，中文 OK（基座 BAAI MIT）。
- 升级档 `onnx-community/bge-reranker-v2-m3-ONNX` + **必须显式 q8**（571MB，8K 上下文，Apache-2.0；
  其 fp32 是 657KB 桩 + 2.27GB 外挂数据，默认路径直接坏）。
- ⚠️ **最大坑**：reranker ONNX 输出是 `[batch,1]` 单 logit，`pipeline('text-classification')`
  内部 softmax → **恒等于 1.0，静默失效**。必须自己 `AutoModelForSequenceClassification` +
  `logits.sigmoid()`；pair 输入走 `tokenizer(queryArr, { text_pair: passagesArr })`（等长数组）。
- ⚠️ zen gateway **无 rerank 端点**（公开模型清单 70 个里 rerank/embed 命中 0，POST /v1/rerank 404）
  → 远程 rerank 只剩「LLM 打分」一条路（chatForRag 可复用，但每回合多一次调用）。
- 避开：jinaai/jina-reranker-v2（CC-BY-NC 非商用 + config 缺 model_type + custom_code）、
  onnx-community/gte-multilingual-reranker-base（model_type:"new" 加载即抛错，标了 transformers.js 是坑）、
  Qwen3-Reranker-0.6B（CausalLM 流程 + 1.22GB）、mxbai-rerank-base-v2（无 ONNX）。

---

## 已收敛（Round 1，用户以新提案实质回应）

- 用户新提案（取代原 BM25-lite 换打分提案）为**双阶段路线**：
  - Phase 1：用 #40 冻结数据集跑 #41 训练/SFT/评测（= Round 2 Q1 推荐 A，用户转 #41 即默认采纳）。
  - Phase 2：新分支替换全部 RAG——LLM 按 story 预生成场景图（场景/事件/线索，替代索引）+ KP 交互用 agentic search；之后重备训练集、SFT、评测。
- 关键侦查事实（已验证，file:line 见会话）：
  - vectorStore 查询侧硬依赖 embedding、无词面回退，embedder 缺失→情报块静默空（vectorStore.ts:416-419,461-473）；tf/tfidf/idf 写而不读。
  - graphRag 在活路径（ragService.ts:326），有图时输出「## 故事情报（含关系）」另一形态，与不变量#1/训练格式相悖；useGraphRAG 默认 true→索引默认烧 LLM 抽取。
  - userGraphStore 纯死代码（A3 延后，adr/0002:15）。
  - e2e 只断言索引成功计数，无情报块正文断言。
  - 存量索引 JSON 恒含 content，BM25 统计可惰性重算。
- 关键洞见：Phase 1 模型 = Phase 2 的 0-call 优雅降级形态；BM25-lite 不作废，降格为 agentic search 的 `lexical_search` 工具原语与回退保险。

## 待确认（Round 2 推荐，用户未逐条拍板）

- Q1 Phase 1 直吃 #40 冻结 JSONL，不重新生成（省教师 1.68 亿 tok）——已由转 #41 默认采纳。
- Q2 main 线不动（embedding RAG 原样），BM25-lite 立票计划取消。
- Q3 分支按里程碑合回（M1 场景图索引替换 → M2 agentic 回合循环），不搞长驻大爆炸分支。
- Q4 agentic 第一版 = 静态注入为主（当前场景 dossier + 场景索引清单）+ 3 工具（scene_list / scene_dossier / lexical_search）+ 轮内 0-3 次调用预算。
- Q5 场景图生成先离线（training 侧产图、定 schema、人工抽检）再 server 化。
- Q6 Phase 3 从 Phase 1 权重续训 + 评测加检索行为指标（搜索次数分布/命中率/轮延迟）；ADR-0006 基座决策不动。

## 最大风险（贯穿 Phase 2/3）

8B SFT 模型学会稳定 agentic search（工具调用）——回合协议/流式/多人编排/训练数据格式（多轮工具轨迹）/评测五处联动。Q4 的静态为主设计是保险。

## 产出欠账（grilling 复活后执行）

ADR-0007「RAG 双阶段演进路线」+ Phase 2 里程碑票链 + CONTEXT.md「嵌入端点」词条随 Phase 2 落地改写（现阶段不动）。
