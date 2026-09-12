# 自训 KP 模型 / 内置模型 serving

本项目不再推进"在项目回合契约上 SFT 出自训 KP 模型"的方向（ADR-0006 的训练侧），
守秘人模型维持 **BYOK**（用户自带端点/key）。内置模型（服务端持有端点配置、
serving/配额/降级）随训练方向一并搁置——若将来重启，须走新的 ADR/票变更，
并以本文件为"上次走到哪"的起点。

## Why this is out of scope

用户在 2026-09-07 评估后决定放弃自训、维持 BYOK（#41 关闭时执行了本地回退
`e2acd9c` 与云端 Kaggle 资源清理）。核心权衡：

- Kaggle 免费算力约束硬：P100 不可用、仅 T4×2，QLoRA 是唯一可行档位
  （全参 SFT 不可行；升级光谱 rank↑→去量化→全参在 T4 下均不现实）；
- LF 钉死 v0.9.3 带来持续摩擦（无 openai converter / 无 export_dtype /
  anchors 注册不训练等一串绕行约定）；
- BYOK + mimo-v2.5 的实际游玩质量已达可用，自训模型的边际收益不抵
  数据管线维护 + 训练运维成本。

训练方向放弃 ≠ 资产作废——以下已交付资产保留在代码库/git 历史：

- **蒸馏数据管线**（`training/src/distill/`，T4）：教师重放 + 离线规则引擎
  真骰子结算，`npm run kaggle:pack` 一条命令出数据包；
- **金样本评测集 + 评测 harness**（`training/eval/`，T3）：57 条标准情境 →
  期望工具/参数，对任意 openai_chat 端点产出格式遵循率与裁定正确率；
  **mimo-v2.5 的 BYOK 基线已存在**（`training/eval/reports/baseline-mimo-v2.5-2026-09-05.json`，
  gitignore 数据）；
- **wire 采样日志**（T1，`kp_wire_samples` 表）：真实回合 wire 序列持续落库，
  是将来任何训练/评测的数据地基。

注意：M1/RAG 改革（2026-09-12 合并）改动了 `kpPromptService` 的 workflow 分支，
上述 baseline 快照相对新提示词已过时；如需刷新基线，重新跑 harness 即可
（不需要重启训练方向）。

## Prior requests

- #36: Spec：自训 KP 模型一期——回合契约 SFT（蒸馏 + QLoRA + 三层评测）
- #41: T5：Kaggle 打包/推送/训练/回传（已随放弃回退关闭）
- #42: T6：三层评测 gate 执行——格式/金样本/人工盲评
- #43: T7：gate 判定与后续立项（内置模型票 / 迭代票）
