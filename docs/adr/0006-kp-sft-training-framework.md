# ADR-0006：KP 自训模型（SFT）训练框架——LLaMA-Factory QLoRA，否决 Megatron

- 状态：已接受（2026-09-05）
- 关联：ADR-0003（openai_chat 协议一等公民）、shared/tools/cocTools.ts（24 工具输出契约）、server/src/services/kpPromptService.ts（提示词纯函数）、server/src/services/kpTurnService.ts（工具循环）

## 背景

为让守秘人（KP）能力摆脱通用基座模型的上限，决定 SFT 一个「更会当 KP」的模型：输出契约沿用现有回合管线（中文叙事正文 + cocTools `tool_calls`，validate 规则——required 工具检查 / 文字模拟骰子正则——既是产品质量门槛也是客观评测器）；样本 context 侧由 kpPromptService 纯函数确定性重建。基座 Qwen3-8B（中文叙事 + function calling 成熟，Apache-2.0 可分发）。可用算力：本地 RTX 5060 8G + Kaggle 免费 GPU（T4×2 / P100 16G，约 30h/周）。最初倾向 Megatron。

2026-09 调研结论：Megatron 路线在本场景全部不可行——

1. **LLaMA-Factory 的 Megatron 后端（MCA，`USE_MCA=1`）只支持 full 全参微调，不支持 LoRA**（feature request issue #9535 无维护者回复、无排期），官方示例最低单机 8×80G；
2. **原生 Megatron-LM 无官方 LoRA 路径**：Megatron-PEFT 仓库已 404（被收编），继任者 Megatron Bridge 面向 DP/TP/PP/SP/EP 多卡并行、要求 HF→mcore 权重转换与 NGC/transformer-engine 栈；
3. ms-swift 的 Megatron 变体（Megatron-SWIFT）示例环境为 16×A800。

显存现实：unsloth 实测 Qwen3-8B QLoRA 约 12G——本地 5060 8G 连 QLoRA 都放不下 8B 训练。

## 决策

1. **训练框架 = LLaMA-Factory（HF 后端 + QLoRA）**：服务端内部统一消息形态即 OpenAI chat messages（ADR-0003），LLaMA-Factory 原生直接吃 `messages`+`tools` 字段（注册 dataset_info.json 即可，零格式转换）；`llamafactory-cli export` 一键合并权重。
2. **训练环境 = Kaggle T4×2 / P100 16G**；本地 5060 8G 定位为数据构建 + 4-bit 量化推理评测/自用（约 6G 可容）。
3. **序列策略 = 变量块瘦身**：BASE_INSTRUCTIONS 与角色卡结构保持全长（行为契约核心分布），训练集构建时 RAG top8→4、近窗 18→8、记忆 30→12，序列 cap 约 6k；部署仍用全长 prompt，分布迁移由三层评测验证（格式遵循 ≥99% / 金样本裁定 ≥90% / 人工盲评不输基座）。
4. **数据形态 = OpenAI messages + `tool_calls` JSONL**（Hermes 风格 tool use，Qwen3 tokenizer 原生模板）；来源混合——真实对局快照（rooms.state）抽取 context 骨架 + 教师模型（用户 command code 配置的 DeepSeek V4 Flash）按项目提示词蒸馏理想回复 + mockAi/e2e 金样本做格式锚 + 少量人工示范；validate 规则做合成数据自动过滤。一期目标约 2000 条精选（含 ≥500 条多步工具链）。
5. **部署 = 合并权重经 vLLM 提供端点**（vLLM 原生 API 即 OpenAI 兼容形态，`--tool-call-parser hermes` 闭环）；消费侧复用既有 `openai_chat` 协议适配器，协议层零新增。
6. **现状与目标态**：一期产物为「通过评测的合并权重 + 自用实测」；产品内置模型为目标态，serving/配额/降级/分发在其评测达标后单独立票（服务端持有端点配置，非用户 BYOK 设置页）。

## 被否决的替代

- **(a) Megatron 全家桶（MCA / 原生 / Bridge / NeMo / Megatron-SWIFT）**：见背景三条，且与 16G 消费级/免费算力相差两个量级，本场景纯负资产。
- **(b) ms-swift**：Qwen 官方钦定路径、agent template 对 tool_calls 映射最深，但 8B LoRA 官方标称 22G，T4 上必须绕 QLoRA；留作 LLaMA-Factory 模板渲染异常时的备胎。
- **(c) unsloth**：最省显存最快（T4 友好），但多步 tool_calls 链需手工套 hermes 模板，与「wire 格式零转换」目标冲突，格式保真风险最高。
- **(d) 5060 8G 本地训练**：低于 Qwen3-8B QLoRA 实测需求（~12G），仅保留其数据构建与推理评测职责。

## 后果

- 训练/评测/数据管线脚本为独立工作区（不进 server 运行时依赖）；repo 需新增两件事：`runKpTurn` wire 采样日志（原始 tool_calls 与当轮 RAG 注入落库，让以后的局直接攒成可用数据）+ 从 rooms.state/saves 抽样的数据导出器。
- 本地 5060 做推理评测需 4-bit 量化（AWQ/GPTQ）；产品内置若启动，服务端需自持 GPU 推理基建与配额设计（独立票）。
- Qwen3-8B 为 Apache-2.0，微调合并权重可合规分发（内置前提）。

## 附注

本 ADR 首次落盘时恰逢 F: 盘硬件级 I/O 故障窗口，Write 曾报 fsync 错误；故障修复（chkdsk）后原文件被清除，本文为重建版（内容与决策不变）。
