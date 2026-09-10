# 服务端自动预取原文查证（P27）——触发率从 0 到有，代价是回合延迟

> 2026-09-10（实验分支 feature/kp-dossier-workflow）。
> P25 发现"查证工具几乎不被调用"（40 个 dossier 游玩回合合计 1 次）；P26 用纯提示词
> 干预（覆盖提示 + 事实问规则）重测，触发率仍是 0/10 → 证伪。P27 改为**服务端判定并
> 预取**（P25 遗留的 (c) 方案）：不再依赖 KP 自觉。
>
> 相关：`dossier-runtime-fallback-ab-2026-09-10.md`（P25）、`dossier-trigger-rate-p26-2026-09-10.md`（P26 证伪）。

## 0. TL;DR

| 项 | 结果 |
|---|---|
| 机制 | 服务端在 flushTurn 前判定（事实问句 + 档案对不上问题措辞）→ 调 `verify_original` → 结论并入本轮 system（`## 原文查证（服务端已自动检索）`），对玩家不可见 |
| **预取确实生效** | A/B 的 dossier 房 10 个游玩回合中 **2 个回合的 system prompt 含预取块**（wire 采样逐回合核验）——对比 P26 的 0 次，机制通了 |
| 副作用（新发现） | 预取在 system 组装前**内联等待**，是回合首字延迟的直接增量；该跑第 6 回合（"情报确认：…哪些…"正是问句）**超时失败**（harness 240s 等待上限） |
| KP 行为变化 | 同一跑里 KP 自己调了 1 次 `verify_original`（P25/P26 各 1/0 次），另在 2 个事实回合主动调用——预取块进上下文后，KP 对"可以查原文"的感知似有提升（样本太小，仅记观察） |
| 工程 | 577 项测试绿、tsc 净；双轴 code-review 修复 9 项（问句误判收紧、重复 IO、死参数、命名、超时 90→60s 等） |

## 1. 机制与判定（commit 50f64f7 + ce6602c）

落点 `server/src/rag/dossier/prefetch.ts`（判定与执行）+ `roomService.prefetchVerification`
（回合前调用）+ `kpPromptService.buildKnowledgeBlock`（拼进 system）。

**触发（三条全中才触发；每次触发 = 一次 20–40s 的真实 LLM 调用，宁缺勿滥）**：
1. 玩家发言是**事实问句**——含问号，或疑问词在问句位置（"吗/呢"只在句读边界算，
   避免"吗啡""呢绒"误判；无问号时排除"我想知道…""我看看…有什么"这类叙述框架）；
2. 当前场景档案**对不上问题措辞**——问题 CJK 二元组在档案块的命中率 < 0.5；或压根
   没有场景块（房间场景未匹配档案）；
3. 场景覆盖率未达 85%（已知档案基本完整时，问题多半不在剧本里——省下这次调用）。

**执行与降级**：复用 `verify_original`（含剧透层标注与同问同场景的进程内 TTL 缓存）→
60s 超时 → `ok=false`/超时/抛错一律返回 null（不注入、不阻断回合）。

## 2. 验证 A/B（火焰交织的盛夏，10 回合 + 5 事实问）

| 指标 | rag 房 | dossier 房 |
|---|---|---|
| 回合 / 失败 | 10 / 0 | 10 / **1** |
| TTFT p50/p95 | 19.2s / 50.9s | 38.4s / 88.9s |
| 整回合 p50 | 54.8s | 66.2s |
| 工具调用 | skill_check 2, grant_clue 5, transition_scene 6 | skill_check 3, grant_clue 5, transition_scene 5, scene_list 3, scene_dossier 1, **verify_original 1** |
| **预取注入回合** | — | **2 / 10**（wire 逐回合核验：第 6、7 个游玩回合的 system 含 `## 原文查证` 块） |

**失败回合分析**：第 6 回合玩家输入是"情报确认：根据你目前掌握的情报，这个事件涉及哪些
人物、地点与线索？"——命中问句判定 → 预取触发（最多 90s，本跑为 P27a 的 90s 上限）→
该回合总耗时超过 harness 的 240s 等待上限被判失败。**这正是 code-review 预警的 TTFT 风险
被实测坐实**；P27b 已把上限收到 60s，并把"延迟预算"列为遗留项。

**对局内事实问（P10 次要口径）**：rag 1,1,1,1,1 vs dossier 1,1,1,1,1（fab 各 2）——
与 P25/P26 一样无区分度。**但有一个新观察**：两个事实回合里 KP **自己**调用了
`verify_original`（此前 40 个游玩回合合计 1 次）——预取块出现在上下文之后，KP 对
"可以查原文"的感知似有提升。样本太小，只作观察记录，不作结论。

## 3. 双轴 code-review（范围 50f64f7）

- **Spec 轴**：问句识别假阳性（"吗/呢"词内命中、"我看看…有什么"叙述被当提问 → 每次
  误判 = 一次真实 LLM 调用）→ 已收紧并补 8 例断言；rag 分支可拼查证块的多余通路 → 已 gate；
  预取失败路径静默 → 已并入 KP_LLM_DEBUG 诊断；超时 90s → 60s（延迟预算）。
- **Standards 轴**：CJK 二元组口径重复实现（prefetch 与 originalLookup 各一份）→ 提为
  `originalLookup.cjkBigrams` 单源；同回合重复读 gaps（预取与 fetchDossierContext 各算一次
  覆盖度）→ 覆盖度随 knowledge 回传；死防御（外层 try/catch）、`PRE_*` 命名（易读作 pre-）
  → 已改。

## 4. 结论

1. **机制成立**：服务端判定 + 预取确实把查证从"从不发生"变成"事实问句时会发生"——
   这正是 P25/P26 反复卡住的点。
2. **代价明确**：预取是同步阻塞的，最坏给回合首字延迟加一个超时上限；本轮已观测到
   因此导致的 1 次回合失败（90s 上限时）。**已修（P27d）**：内联等待收到 **15s**，
   且**超时不取消**底层调用——它继续跑完写入 `verify_original` 的 TTL 缓存，后续回合
   命中即免调用（等效异步预热）。代价是"本回合经常来不及注入、改为下一回合受益"，
   收益是延迟不再劣化。三种方案的取舍：
   (a) 纯降超时——简单但丢失大部分注入机会；
   (b) 异步预热（**已采用为 15s 内联 + 超时后继续跑**）——延迟安全，注入命中率换时间；
   (c) 缩短 verify 输出预算 / 并行发起——留作后续（若 15s 内联命中率过低再考虑）。
   下一轮应用 `rec.prefetched` 统计**内联命中率**（15s 内返回的比例）来校准这个数字。
3. **可观测性已就位**：`ab-compare` 新增 `rec.prefetched` 捕获（wire 里的查证小节原文），
   下一轮起预取触发率/内容可直接从报告 JSON 统计。

## 5. 复现

```bash
cd server && npx vitest run && npx tsc --noEmit    # 577 绿

. scripts/eval/llm-env.sh
MOCK_AI=0 AB_AI_MODEL=mimo-v2.5 OPENCODE_SESSION=ab-p27-prefetch E2E_PORT=3303 \
  LLM_TIMEOUT_MS=180000 node scripts/eval/ab-compare.mjs \
  --file "AI-COC-KP Story Document/stories/火焰交织的盛夏_220819_compressed.pdf" \
  --turns 10 --out training/eval/reports/ab-runtime-p27.json
# 预取块：wire 采样里搜 '## 原文查证（服务端已自动检索'
```
