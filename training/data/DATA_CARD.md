# KP 蒸馏数据集数据卡（Data Card）— 票 #40

> 数据集：KP 回合契约 SFT 语料（OpenAI messages + tools JSONL，Hermes 风格）
> 生成管线：`training/src/distill/`（本仓库 `npm run distill -- <stage>`）
> 机器可读统计：`training/out/distill/datacard.json`（生成时写入，含精确 token 计量）
> 架构依据：ADR-0006 决策 3/4；spec #36「数据来源混合」

## 1. 数据用途与形态

- 用途：Qwen3-8B QLoRA（#41，LLaMA-Factory）的 SFT 训练集 + held-out 验证集。
- 形态：每行 `{ meta, messages, tools }`——`messages` 为完整 wire 序列
  （system + 近窗对话 + 合并玩家批次 + 各工具循环轮 `[assistant(tool_calls), tool 回填]`
  + 最终叙事 assistant），`tools` 为线上 `COC_KP_TOOLS` 逐字。
- 部署分布对齐：与线上一比一的请求组装路径（kpPromptService 纯函数）、工具结果
  回填形态（【结果摘要】头 + 截断）、多角色 characterId 分派。

## 2. 来源与配比

| 来源 | 文件 | 说明 |
| --- | --- | --- |
| seed | `train.jsonl` / `heldout.jsonl` | #38 导出器的真实对局骨架（32 房间 + 2 存档，0 wire 采样——#37 刚上线）上教师重放；真实玩家行动批次分布 |
| synthetic | `train.jsonl` / `heldout.jsonl` | rollout 式合成：剧本语料（用户提供《AI-COC-KP Story Document》，13 个故事 2304 chunk）+ 教师生成玩家批次（Phase A）+ 教师重放 KP 回复（Phase B）+ 离线规则引擎真实执行工具 |
| anchor | `anchors.jsonl` | #39 金样本情境 × 教师重放 × #39 judge 裁定通过者（57 条候选）+ mockAi/e2e 场景锚（3 条种子）；工具行为被确定性期望机械验证 |

（精确条数与配比见 `datacard.json` 的 `train/heldout/anchors.count` 与
`byTurnType` 分布——生成完成后由 pack 阶段写入。）

## 3. 变量块瘦身（数据侧，ADR-0006 决策 3）

| 变量块 | 线上 | 训练样本 |
| --- | --- | --- |
| RAG 注入 | top8（embedding 检索） | 前 4 节（离线词面检索近似，见 §5） |
| 近窗对话 | 18 条 | 8 条 |
| KP 记忆 | 30 条 | 12 条 |
| 序列上限 | — | ~6k token（超限丢最旧对话） |
| BASE_INSTRUCTIONS / 角色卡 | 全长 | 全长（不动） |

## 4. 教师与成本

- 教师：DeepSeek V4 Flash（用户 command code 端点；`deepseek/deepseek-v4-flash`）。
- 调用形态：openai SDK，与线上 openaiChat 适配器同参（tools + tool_choice auto）。
- 实测（冒烟）：seed 重放 ~10.2k prompt tokens/条；合成 rollout 每回合
  Phase A ≈ 2.5k + Phase B ≈ 10k×1.4 次调用。
- 全量计量：`datacard.json` 的 `teacher.totalPromptTokens / totalCompletionTokens /
  totalCalls`（按样本 meta.usage 求和）。

## 5. 离线近似与如实标注（caveats）

| caveat | 含义 |
| --- | --- |
| `rag_lexical_approximation_offline` | 合成行 RAG 用离线词面检索（BM25-lite），与线上 embedding 检索不同源 |
| `rag_context_unavailable_offline` | seed 重建行无 RAG 注入（与 #38 同义） |
| `state_blocks_from_final_snapshot` | seed 行记忆/线索/场景取自终局快照 |

- 合成批次的玩家行动由教师生成——「玩家行动分布」为教师条件分布，非真实玩家
  分布（seed 行保留真实批次；数据卡如实区分）。
- rollout 记忆条目采用线上 `rememberTurn` 的确定性兜底分支（finalContent 前 80 字）；
  LLM 抽取点路径不可离线复现。
- rollout ≤9 回合 < 线上长期摘要刷新阈值（10 回合），`longTermSummary` 恒空。

## 6. 过滤（validate 规则单源）

- 规则单源：`shared/tools/kpValidation.ts`（文字模拟骰点正则 + coversRequiredTools
  等价展开）——产品 validate 节点、#39 评测、#40 过滤三处共用。
- 机械检查：24 工具名单内、参数可解析、规则引擎执行无 error、叙事非空、工具循环
  未打满 8 轮上限。
- 回合类型 required 契约：`training/src/distill/turnTypes.ts`（战斗链/san_check/
  chase_turn 等按 BASE_INSTRUCTIONS 强制；opening 与 seed_organic 不设 required）。
- 拒绝分布：`datacard.json` 的 `filter`（分类计数）。

## 7. 切分与零重叠

- held-out（目标 ≥500 条）与训练集**出处级零重叠**：synthetic 按 rollout 整体归属、
  seed 按房间/存档整体归属（同场对局的回合同侧——回合间共享演化状态）。
- 内容级零重叠：contextHash（system+本批 的 sha256）跨侧去重，held-out 优先保留。
- **anchors.jsonl 独立文件，不进 held-out**：金样本锚的 context 与 #42 gate 评测集
  同源——训练时并入会使 gate 第二层（金样本裁定）的通过率偏乐观。#41 注册数据集
  时可自行决定并入与否（建议：并入 train 以稳定格式，评测解读时注意该偏置）。

## 8. 人工抽检（票 #40 验收 4）

- 抽检包：`training/out/distill/audit/`（`checklist.md` 勾选清单 +
  `viewer.html` 自包含查看器，离线可读完整对话）。
- 分层：source × turnType 每层至多 4 条，共 ~60 条。
- 抽检人：用户（agent 不代签）；结果回填 checklist 后决定是否需重跑/增补。

## 9. 数据许可

- 剧本语料：用户自有资料（《AI-COC-KP Story Document》）；仅用于自训模型研究。
- 合成内容：用户自备端点的教师模型生成。
- 无第三方爬取语料（与 spec #36「Further Notes」一致）。

## 10. 复现

```bash
npm run distill -- corpus && npm run distill -- plan --rollouts 300 --seed 20260906
KP_DISTILL_BASE_URL=… KP_DISTILL_API_KEY=… KP_DISTILL_MODEL=deepseek/deepseek-v4-flash \
  npm run distill -- run --concurrency 6
npm run distill -- anchors && npm run distill -- pack && npm run distill -- audit
```

（教师凭据只走环境变量；同种子计划可复现；run 断点续跑。）
