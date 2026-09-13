# docs/experiments 索引（append-only 实验证据链）

> 定位：本目录是 **append-only 实验证据链**——每轮实验的原始报告按时间追加，历史记录不改写（修订走追记）；新实验报告默认写到这里：`node scripts/eval/ab-report.mjs`（不给 `--out` 时输出 `docs/experiments/<label>.md`），落盘后补进下方清单。
> 实验期分支 `feature/kp-dossier-workflow` 的 P10–P27 与 M1 验收报告都在这条链上，结论去向以 `docs/adr/0007-dossier-primary-standard-rag-supplement.md` 与 M1 票（#44 spec / #52 验收）为准。

## 记录清单（13 份）

| 文件 | 轮次 / 票号 | 主题 | 结论去向 |
|---|---|---|---|
| [`dossier-vs-rag-2026-09-07.md`](dossier-vs-rag-2026-09-07.md) | P10 | 档案 + agentic 查证 vs embedding RAG 首轮对比（mock 全链；真实对局因端点不可用未完成） | dossier 线继续（→ P12/P15）；ADR-0007 背景 |
| [`dossier-vs-rag-real-2026-09-08.md`](dossier-vs-rag-real-2026-09-08.md) | 真实 A/B（P10 续） | 10 篇真实对局 A/B：延迟 / 注入 / 工具分布 / 对局后事实追问 | 暴露追问探针失效 → P12 改「档案直答」；ADR-0007 背景 |
| [`dossier-schema-v2-prototype-2026-09-08.md`](dossier-schema-v2-prototype-2026-09-08.md) | P12 | schema v2（图关系层）+ 档案直答探针 + 生成预算修复（8k→16k） | → P15 补 truth/ending 层 |
| [`dossier-schema-v2-1-truth-layer-2026-09-09.md`](dossier-schema-v2-1-truth-layer-2026-09-09.md) | P15 | schema v2.1 truths/endings 剧透层验证（不注入运行时） | → P20 十篇批量 |
| [`dossier-vision-images-2026-09-09.md`](dossier-vision-images-2026-09-09.md) | P16 | 模组图 Vision 处理原型（地图 / 线索卡转录，mimo-v2.5） | → P20 annex 批量并进生成管线 |
| [`dossier-v2.1-annex-batch-2026-09-09.md`](dossier-v2.1-annex-batch-2026-09-09.md) | P20 | v2.1 + annex 10 篇全量生成与直答重建（pooled 3.19，57 问） | P21/P24/P25 的共同基线 |
| [`dossier-fallback-prototype-2026-09-09.md`](dossier-fallback-prototype-2026-09-09.md) | P21 | 原文回退原型（缺失标记 + 全文子代理；触发子集 2.64→3.32） | → P23 定位器 → P25 运行时工具 |
| [`dossier-fallback-locator-p23-2026-09-09.md`](dossier-fallback-locator-p23-2026-09-09.md) | P23 | 定位器对比 grid vs coverage-gaps（统计平手，离线形态到顶） | → P25 场景级定向回退 |
| [`dossier-p24-prompt-fix-2026-09-10.md`](dossier-p24-prompt-fix-2026-09-10.md) | P24 | 抽取提示修复（sceneText 誊抄、truth 交叉一致；覆盖 4.8–8.9%→33.9–63.5%） | 生成期质量；#55 质量门收口 |
| [`dossier-runtime-fallback-ab-2026-09-10.md`](dossier-runtime-fallback-ab-2026-09-10.md) | P25 | `verify_original` 运行时工具 + 回合级 A/B（30 个游玩回合仅 1 次调用） | → P26/P27 触发率攻关；ADR-0007 决策 8 |
| [`dossier-trigger-rate-p26-2026-09-10.md`](dossier-trigger-rate-p26-2026-09-10.md) | P26 | 提示词干预提升触发率——证伪（0/10）+ 2 处顺带修复 | → P27 服务端自动预取 |
| [`dossier-prefetch-p27-2026-09-10.md`](dossier-prefetch-p27-2026-09-10.md) | P27 | 服务端自动预取原文查证：机制成立（2.80/2.80/1.20 vs rag 1.00/1.60/1.60） | ADR-0007 决策 6/8；M1 验收基线 |
| [`m1-supplement-ab-2026-09-11.md`](m1-supplement-ab-2026-09-11.md) | M1-T8 / #52（spec #44） | 检索补充层验收 A/B：事实不退化（3 篇）+ 纹理部分达成 + 延迟 | ADR-0007 落地状态；派生 #53/#54/#55 修复 |

## judge 口径与 P10 无区分度教训（全仓仅此处承载）

**judge 口径**：LLM-as-judge（mimo-v2.5，与被评同一模型，盲评）按 1–5 忠实度 + fabrication 标记（编造 NPC/地点/真相）打分，题源为剧本原文出处的 ground-truth 问题（5 问/篇，引证可核），回答全文留档可人工复核。判读注意：自评偏差可能存在；存在「3 分墙」（对无法核验的额外细节保守扣分，P21/P23/P25 同象）；小样本跨轮 ±2 是已知噪声，只读趋势不抠单分。

**P10 无区分度教训**：「对局内 / 对局后事实追问」这个口径量的是 KP 的在场叙事策略，不是知识质量——KP 处于扮演态会拒答 / 答偏，两房分数系统性不可分：真实 A/B 两房 1.60 vs 1.58（fab 约 30/50，来源 `dossier-vs-rag-real-2026-09-08.md`），P25 复现同象（rag 2.40 vs dossier 1.40，火焰篇两房全 1 分，来源 `dossier-runtime-fallback-ab-2026-09-10.md`）。**该口径不可作主度量，只作次要记录**；主度量改用「档案直答」探针（不经对局，P20 起）或隔离实验（M1：档案房 ± 补充层 ON/OFF）。
