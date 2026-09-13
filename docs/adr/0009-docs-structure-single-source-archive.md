# ADR-0009：docs 结构——单一真源 + history/ 死文件归档层（README 索引为唯一入口）

- 状态：已接受（2026-09-13）
- 关联：spec #99（docs 重组，11 项决策经 2026-09-13 grilling 拍板）；执行票 #100（失真止血）、#101（真源收敛）、#102（结构归档，本 ADR 随票落地）；ADR-0004（design/ 令牌映射随本决策归档）、ADR-0008（REST 退役波的文档 sweep 先例）

## 背景

架构走查 41 票 + REST 退役波（ADR-0008）落地后代码已收敛，docs 层却积压三类债：① **失真**——9 处陈述与代码矛盾（DEPLOYMENT 停在 v0.2.0 时代、training/README 仍描述已退役 `--save` 流程等，已由 #100 止血）；② **重复**——12 类知识中 7 类存在多文档平行叙述（「回合链路/数据流」在 ONBOARDING-GUIDE 与 PROJECT-ANALYSIS 几乎逐字重复），文档间漂移与代码-文档漂移是同一种病；③ **现行/史实混居**——docs/ 根平铺了执行完毕的迁移计划、审计快照、已被取代的分析报告，agent 与新人无法一眼分辨哪些文档还「活着」，把 2026-08 设计史当现行事实的风险真实存在。

docs 目录形状此前从未被决策记录过，靠历史惯性长成。本次重组需要一次拍板并以 ADR 固化，避免下一轮整理重复讨论。本决策通过 ADR 三要素检验：**① 难逆转**——文件移动 + 全仓链接更新是一次性成本，回退要再付一遍；**② 无上下文会困惑**——未来读者会问「history/ 为什么不直接删」「experiments/ 为什么活档案不归档」「CONTEXT/AGENTS 为什么留在仓库根」；**③ 真实取舍**——归档 vs 删除、原地 vs 搬家、单索引 vs 多入口各有代价，且与代码侧路径引用（ab-report 默认输出目录）强耦合。

## 决策

1. **单一真源原则**：每类知识恰一个 canonical 文档，其余位置只留薄指向。分配落点——项目定位 / FR-NFR / 模块地图 / KP 状态机 / 线索门控 / 回合链路 / Bridge-WS / 表清单 / 安全设计 = `docs/ONBOARDING-GUIDE.md`；双轨知识口径 = `CONTEXT.md`；测试数字 = `README.md`；部署 = `docs/DEPLOYMENT.md`；接口面 = `docs/api-contract.md`；决策史维持三流分工（ADR + DEVELOPMENT-LOG + CONTEXT「不重议的决策」）不合并；roadmap 单源在 README。重复段删除后只留指针。
2. **`docs/history/` 死文件归档层**：不再变更的史实文件整目录迁入，正文零改写（仅 PROJECT-ANALYSIS 头部加「已被 ONBOARDING-GUIDE 取代」指针），引用方全量改指 `docs/history/` 新路径。当前名单（5 项）：MIGRATION-PLAN.md、DEPENDENCY-AUDIT-2026-09-04.md、ARCHITECTURE-MULTIPLAYER.md、PROJECT-ANALYSIS.md、design/（uni-scss 令牌映射表 + preview 图）。**归档而非删除**：史实仍被引用（CONTEXT「不重议的决策」引 ARCHITECTURE-MULTIPLAYER §四、ADR-0001/0002/0005 引其章节、ADR-0004 引 design/ 令牌表、PROJECT-ANALYSIS §13/§15 性能实测史实），删除会让这些指针悬空。
3. **`experiments/`、`research/` 活档案原地 + 索引**：append-only 证据链不搬进 history/，留 `docs/` 根下子目录并补索引（`docs/experiments/README.md` 承载 13 份清单 + judge 口径 + P10 无区分度教训；`docs/research/` 保持原样、仅登记进 README 索引行）。留原地同时保证代码侧对 docs 路径的引用（`scripts/eval/ab-report.mjs` 默认输出目录 `docs/experiments/`、ab-compare 输出提示、dossier annex 注释）零改动。
4. **README 文档索引原则**：README「文档索引」节是文档的唯一入口，分两层覆盖——现行区（CONTEXT / AGENTS / ONBOARDING-GUIDE / DEVELOPMENT-LOG / DEPLOYMENT / api-contract）+ 指引层（`docs/adr/`、`docs/agents/`、`docs/experiments/`、`docs/research/`、`docs/history/`）；roadmap 节保留原位（README）不动。新增目录/文档时索引同步更新，不允许「有文档无索引」。

## 被否决的替代

- **(a) 删除死文件而非归档**：git 历史能找到 ≠ 读者能找到；史实段落正被现行文档与 ADR 引用（见决策 2），删除需同步删除全部引用，且 PROJECT-ANALYSIS 的性能实测史实（§13/§15）仍有检索价值。
- **(b) 保持平铺、只在文件头加「已过时」标注**：现行/史实混居正是本决策要治的病；标注依赖读者逐文件打开，目录层不分层则索引与 glob 都分不出死活。
- **(c) `experiments/`、`research/` 一并归档进 history/**：二者仍在追加（append-only 活档案），搬移会破坏代码侧默认输出路径与 ADR-0006/0007 的引用，且给「新实验报告写哪」制造歧义。
- **(d) 文档平台化 / 渲染站点 / 多入口索引**：读者定位是 agent-first、人可读为辅，仓库内 Markdown + README 索引已满足，站点是超范围设施。
- **(e) 决策史三流合并为单一 changelog**：ADR（决策与替代）/ DEVELOPMENT-LOG（实现决策）/ CONTEXT 不重议清单三种粒度用途不同，合并即丢信息。

## 后果

- `docs/` 现行区根只剩 ONBOARDING-GUIDE / DEVELOPMENT-LOG / DEPLOYMENT / api-contract + 子目录 `adr/`、`agents/`、`experiments/`、`research/`、`history/`；`CONTEXT.md`、`AGENTS.md` 按工具约定留在仓库根。
- 引用全量更新（本票执行）：CONTEXT「不重议的决策」的 ARCH §四引用、ADR-0001/0002/0004/0005、`api-contract.md` 两处、ONBOARDING-GUIDE 四处、DEVELOPMENT-LOG 架构依据行、README 依赖审计行改指 `docs/history/`；ADR 用追记文风（「路径已随 #99 归档调整」）不改写史实正文。
- `docs/experiments/` 索引（#101 落地）约定：新增报告必须落清单（append-only 约定不变）；`docs/research/` 保持单文件原地，仅在 README 索引登记。
- **已知残留（存疑留档）**：`client/src/App.vue` 注释仍指 `docs/design/uni-scss-to-brilliant-token-map.md`（本票硬约束只改 docs、不碰代码，未同步；不影响运行与测试）；history/ 内被移文件正文里的旧内联路径按「正文零改写」原则保留（均为非链接文本，不构成断链）。两条留待后续 docs 票或代码注释清理时处理。
