# verify_original 触发率提升尝试（P26）——提示词干预未生效 + 两个顺带修复

> 2026-09-10（实验分支 feature/kp-dossier-workflow，紧接 P25）。
> 动因：P25 回合级 A/B 发现"30 个游玩回合只调用 1 次查证工具，而同一批问题工具直答
> 3.4 分 vs 房内 1.8 分"——缺口是触发率不是工具能力。本轮做提示词侧干预并重测。
>
> 相关：`dossier-runtime-fallback-ab-2026-09-10.md`（P25，本报告回答其 §6 遗留 1）。

## 0. TL;DR

| 项 | 结果 |
|---|---|
| 干预 | 场景块附"原文收录：约 X%（另有 N 段未收录）"提示 + 档案落空引导句 + 事实问规则（先查证再答） |
| **效果（-营，10 回合）** | **触发率未上升：`verify_original` 仍 0 次调用**（提示确实进了 system prompt——wire 采样逐回合核验） |
| 顺带修复 1 | `coverageGaps` 的 gap span 会吞掉紧随其后的被覆盖段 → 10 篇 gapPct 高估 6–11 点（P26a） |
| 顺带修复 2 | `baseInstructionsFor('rag')` 把字面占位符 `{KNOWLEDGE_SOURCE_INSTRUCTION}` 留进 system prompt（P3 起的回归） |
| 工程 | gaps.json 加算法版本戳（GAPS_VERSION）；场景区域常量三处重复收敛为单源；断言加强 |
| 单测/回归 | 新增 28 项（场景覆盖度 5 / 提示与落空 2 / 提示词 4 / 其余为加强），server 全量 **561 绿**、tsc 净 |

## 1. 干预内容（commit b1d1dc2）

1. **场景级覆盖度**（`coverageGaps.computeSceneCoverage`，纯函数）：把 story 级 gap spans
   按场景锚点区域（首锚点−300 .. 末锚点+2500）归属，得出该场景 `coveragePct / gapCount /
   regionChars / gapChars`；无锚点（纯摘要）或未知场景返回 null。
2. **场景块覆盖提示**：`buildSceneBlock` 增加可选 coverage 参数，有缺口时追加
   `原文收录：约 X%（另有 N 段未收录）——需要原文级细节时可用 verify_original 在剧本原文中查证，不要凭印象补全。`
   两个调用点（`fetchDossierContext` 每回合、`scene_dossier` 工具）均已传入。
3. **落空引导**：`scene_dossier` 未命中场景 / `lexical_search` 零命中时，回包统一追加
   "档案可能不全——可用 verify_original 在剧本原文中查证"（`renderSceneNotFound` /
   `renderLexicalMiss`，共用 `VERIFY_ORIGINAL_HINT` 单源常量）。
4. **事实问规则**：`WORKFLOW_KNOWLEDGE_SOURCE.dossier` 增加——"调查员问及具体事实
   （人名、地点、时间、数字、原文措辞）而档案没有明确写出、或你不敢肯定时，**必须先调用
   verify_original 查证**再叙事，禁止凭印象作答"。

## 2. 重测（真实 LLM，-营一日的恐怖，10 回合，`ab-runtime-p26.json`）

| 指标 | rag 房 | dossier 房 |
|---|---|---|
| 回合 / 失败 | 10 / 0 | 10 / 0 |
| TTFT p50/p95 | 18.9s / 63.3s | 37.3s / 48.5s |
| 整回合 p50 | 36.7s | 51.7s |
| 注入 token | 64,517 | 1,710（含新增提示行） |
| 工具分布 | skill_check 1, grant_clue 6, transition_scene 6, inspiration_check 1 | skill_check 1, grant_clue 3, transition_scene 5, **scene_dossier 2, scene_list 1** |
| **verify_original** | — | **0 次** |

**接线已确认生效**（不是提示没送到）：从 wire 采样逐回合核验，dossier 房第 2–10 回合的
system prompt 里 `## 当前场景档案` 与 `原文收录：…` 提示行、以及"必须先调用 verify_original"
规则均在文本内。

**对照 P25 同篇**：P25 该篇 10 回合调用 1 次；本轮 0 次。**合并 P25+P26 共 40 个 dossier
游玩回合，`verify_original` 合计 1 次**——提示词干预没有改变 KP 的行为。

**混淆因素（必须记录）**：本轮现场的档案生成质量远差于 P25（coverage **5.3%**、仅 3 个场景，
harness 质量门给出"疑似严重欠抽"告警；P25 同篇为 48.4%/5–6 场景）。即"提示了却仍不查"
是在**档案明显残缺**的极端条件下观测到的——这反而加强结论：即使提示写明"覆盖率很低、
另有 N 段未收录"，KP 仍不调用查证工具。单篇单次跑，不排除噪声，但方向与 P25 一致。

**对局内事实问（P10 口径，次要）**：rag 3,1,1,1（1 题 judge 失败）vs dossier 1,1,1,1——
与 P25 同向（rag 房在提问当回合按问题检索，dossier 房没有这一步）。

## 3. 顺带修复（两处真缺陷）

**P26a — gap span 吞掉被覆盖段**（`coverageGaps.ts`）：`closeGap(b.end)` 在遇到被覆盖块时
把该块整体算进上一段缺口，gapChars/gapPct 系统性偏高。改为在前一个未覆盖块处收口。
10 篇缓存档案重算实测：**gapPct 普遍高估 6–11 个百分点**（-营 31.8→20.3、巫 65.8→52.5、
火焰 73.9→62.6、模组集 67.1→60.9），spans 数不变。P20/P24 报告里"缺失比例偏高"有一部分来自这里。

**P26c — rag 房 system prompt 的占位符回归**（`kpPromptService.ts`）：`baseInstructionsFor`
的 rag 分支直接返回 `BASE_INSTRUCTIONS`，字面 `{KNOWLEDGE_SOURCE_INSTRUCTION}` 原样进了
system prompt（P3 引入）。这意味着 **P10 起的历轮 A/B，rag 房一直带着这行坏文本**——影响面
需要记账（不改变 P25"两房对比"的相对结论，因为 rag 房是所有轮次的共同基准）。

## 4. 双轴 code-review 结论（/code-review，范围 P26a..P26c）

- **Standards 轴**：无明文约定违规。有效判断题 3 类已修——场景区域常量三处重复（收敛为
  coverageGaps 单源，`originalLookup` 复用）、两处死分支/死防御（`closeGap` 不可达分支、
  `loadGaps` 外重复 catch）、命名与既有词汇不一致（`pct/gapSpans` → `coveragePct/gapCount`）。
- **Spec 轴**：缺失项 1（引导句未提为常量 → 已提 `VERIFY_ORIGINAL_HINT`）；实现风险 1
  （gaps.json 无算法版本 → 已加 `GAPS_VERSION` 并在落盘时打戳、10 篇缓存已重算重戳）；
  断言强度 2（"rag 逐字节不变"与"事实问规则"的弱断言 → 改为逐字节比对与逐项断言）。
- 结论：两轴均无遗留未处理finding（判断题中"覆盖提示口径措辞"保留原样，见下）。

## 5. 结论

1. **纯提示词干预不足以提升查证工具触发率**（P26 主负结论）：把"档案可能不全"写成显式
   数字、把"事实问先查证"写成强制规则，KP 仍不调用——它宁可换用 `scene_dossier`/`scene_list`
   查档案，或在档案残缺时直接凭印象叙事。
2. 因此 P25 遗留 1 的 (a)(b) 两个提示词方案**已被证伪**，剩下 (c) **服务端自动预取/注入**：
   由服务端在"档案零命中 + 问题含事实名词"时直接执行一次 `verify_original` 并把结果并入
   上下文——不依赖 KP 的自觉。这是下一轮的首选项。
3. 顺带修复改变了历史基础数据：gapPct 全线下降 6–11 点（P22/P24 报告的相关数字应按新
   算法理解）；rag 房提示词恢复为 main 形态。
4. 场景覆盖提示本身仍有信息价值（服务端已知、可观测、零 LLM 成本），保留；但如果下一轮
   走自动预取，它的作用就从"提示 KP"变成"服务端自己的触发信号"。

## 6. 复现

```bash
# 单测与回归
cd server && npx vitest run && npx tsc --noEmit

# 触发率重测（需真实 LLM 环境）
. scripts/eval/llm-env.sh
MOCK_AI=0 AB_AI_MODEL=mimo-v2.5 OPENCODE_SESSION=ab-p26-runtime E2E_PORT=3301 \
  node scripts/eval/ab-compare.mjs \
  --file "AI-COC-KP Story Document/stories/-营一日的恐怖_20231103.pdf" \
  --turns 10 --out training/eval/reports/ab-runtime-p26.json
```
