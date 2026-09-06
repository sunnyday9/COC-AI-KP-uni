# 调研：Qwen3.8-9B-Distill（Qwen3.5 / Gated DeltaNet 架构）与训练/部署栈的兼容性

- 调研日期：2026-09-06
- 目标模型：[empero-ai/Qwen3.8-9B-Distill](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill)（Apache-2.0，base_model: Qwen/Qwen3.5-9B，9.65B 参数）
- 架构确认（来自模型 `config.json`）：`architectures: ["Qwen3_5ForConditionalGeneration"]`，`model_type: qwen3_5`（text 部分 `qwen3_5_text`），32 层按 3:1 交替 `linear_attention`（Gated DeltaNet，`linear_conv_kernel_dim: 4`、`linear_num_value_heads: 32`）与 `full_attention`（`full_attention_interval: 4`），`dtype: bfloat16`、`mamba_ssm_dtype: float32`，262K 上下文。来源：[config.json](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/raw/main/config.json)
- 训练计划（被评估对象）：Kaggle 免费 GPU（T4×2 SM75 / P100 16G）+ LLaMA-Factory QLoRA（HF 后端，bitsandbytes 4bit）
- 部署计划（后续票）：vLLM，`--tool-call-parser hermes`

---

## 1. 结论速览

| # | 问题 | 结论 | 一句话依据 |
|---|------|------|-----------|
| 1 | LLaMA-Factory 对 Qwen3.5 / GDN 的支持 | **支持**（v0.9.5 起，2026-05-30） | v0.9.5 changelog 明写 "Added primary support for Qwen3.5/Qwen3.6/Gemma4"；`qwen3_5` 模板 + Qwen3.5-9B 模型注册均在 main 分支；官方博客有 Qwen3.5-9B LoRA SFT 实操，但存在 packing 支持不佳、个别 SFT 报错等毛边 |
| 2 | peft/QLoRA(4bit) 与线性注意力层兼容性 | **部分支持，QLoRA 4bit 明确不被推荐** | Unsloth 官方："不建议对 Qwen3.5 做 QLoRA (4-bit) 训练，无论 MoE 还是 dense"；社区实测 bitsandbytes 对该架构会跳过约 90% 的层；纯 LoRA 有实证（官方博客 + 本模型的社区 fine-tune 谱系），QLoRA 4bit 未见成功公开报告 |
| 3 | flash-linear-attention / causal-conv1d 的 GPU 支持矩阵 | **T4 (SM75) 不在官方支持矩阵内；P100 (SM60) 出局** | FLA 的 CUDA extra 要求 `triton>=3.3`，而 Triton 3.3+ 官方仅支持 Compute Capability 8.0+（Triton 3.2 是最后支持 7.0+ 的版本）；FLA CI 仅覆盖 H100/MI300/B580/Ascend；P100 被 PyTorch CUDA 12.4+ 轮子直接抛弃 |
| 4 | vLLM 对 Qwen3.5 混合线性注意力的服务支持 | **支持**；text-only dense 检查点需 **v0.27.0+，建议 v0.28.0+** | v0.17.0 全家族支持 GDN；v0.27.0 (2026-08-10) 加入 "Qwen3.5 text-only dense and MoE models"；v0.28.0 (2026-08-26) 修 text-only checkpoint 问题；`hermes` parser 是 Qwen 系标准做法，但有 streaming 已知 bug |
| 5 | 社区实证（HF Discussions / 量化版本） | **部分验证：推理栈旁证充分；无 LLaMA-Factory/QLoRA 公开报告；仓库信誉有争议** | 官方 GGUF（43 万下载）、MLX、NVFP4-GGUF、姊妹仓库 GPTQ int4 均存在（推理栈可跑的旁证）；16 条讨论中约 10 条是 spam 举报/命名批评，官方 chat template Jinja 被报有 bug；未找到任何人用 LLaMA-Factory/QLoRA 训练该模型的公开报告 |

**总体判定：训练（Kaggle T4×2 + QLoRA）No-Go；vLLM 部署有条件 Go。** 详见第 3 节。

---

## 2. 各问题详细发现

### 2.1 LLaMA-Factory 对 Qwen3.5 / 线性注意力（Gated DeltaNet）的支持

**结论：支持（v0.9.5 起），属一等公民，但有性能与稳定性毛边。**

证据：

1. **Release notes**：[LLaMA-Factory v0.9.5（2026-05-30）](https://github.com/hiyouga/LLaMA-Factory/releases/tag/v0.9.5) — "Added primary support for Qwen3.5/Qwen3.6/Gemma4 models and compatibility with Transformers v5"，并含相关 PR：
   - [#10147 update peft, deepspeed, adapt transformers v5](https://github.com/hiyouga/LlamaFactory/pull/10147)
   - [#10213 [model] Adapt Qwen3.5](https://github.com/hiyouga/LlamaFactory/pull/10213)
   - [#10227 [fix] register visual part for Qwen3.5](https://github.com/hiyouga/LlamaFactory/pull/10227)（与本模型的 `ForConditionalGeneration` 多模态包装直接相关）
   - [#10237 [model] support Qwen3.5 all series models](https://github.com/hiyouga/LlamaFactory/pull/10237)
2. **模板注册**（main 分支 [template.py](https://github.com/hiyouga/LLaMA-Factory/blob/main/src/llamafactory/data/template.py)，行 2325–2367）：`qwen3_5`、`qwen3_5_nothink`、`qwen3_6` 三个模板，且均带 `format_function=FunctionFormatter(..., tool_format="qwen3_5")` 与 `format_tools=ToolFormatter(tool_format="qwen3_5")` —— 训练侧原生支持 function calling 数据格式。
3. **模型注册**（main 分支 [constants.py](https://github.com/hiyouga/LLaMA-Factory/blob/main/src/llamafactory/extras/constants.py)）：`Qwen3.5-9B-Base` / `Qwen3.5-9B-Thinking`（指向 `Qwen/Qwen3.5-9B`，template=`"qwen3_5"`，行 2979–3000）；`qwen3_5` 同时出现在 `MCA_SUPPORTED_MODELS`、`MEGATRON_BRIDGE_SUPPORTED_MODELS`、`MROPE_MODELS` 列表中。
4. **官方实操博客**：[Fine-Tuning Qwen3.5 for Humanoid Robot](https://blog.llamafactory.net/en/posts/qwen3_5_finetuning/) — 用 LLaMA-Factory（LoRA）微调 Qwen3.5-9B 的完整教程：建议 ≥32GB 显存的 GPU；RTX 5090 上 405 样本约 30 分钟；建议从源码安装 flash-linear-attention（PyPI 版可能性能劣化）。
5. **已知毛边（issue）**：
   - [#10221 qwen3.5-27b 全参微调训练耗时很久](https://github.com/hiyouga/LlamaFactory/issues/10221) — 全参微调比 Qwen3 14B/32B 慢 4 倍以上、GPU 利用率波动；评论指出 "qwen3.5 貌似现在没有很好支持 packing"（线性注意力架构的训练效率问题）。
   - [#10270 Qwen3.5 SFT 训练报错](https://github.com/hiyouga/LlamaFactory/issues/10270) — 0.9.5.dev0 + transformers 5.2.0 + 2×H100 上 Qwen3.5-4B 全参 SFT 报错（template `qwen3_5` 能正常进入训练流程）。
6. **依赖约束**（main 分支 [pyproject.toml](https://github.com/hiyouga/LLaMA-Factory/blob/main/pyproject.toml)）：`transformers>=4.55.0,<=5.8.0,!=4.57.0,!=5.6.0`、`peft>=0.18.0,<=0.18.1`、`torch>=2.4.0`。

**对本模型的适配注意**：distill 仓库的 `architectures` 是 `Qwen3_5ForConditionalGeneration`（含 image/video token 的多模态包装），`model_type: qwen3_5` —— LLaMA-Factory 按 model_type 识别为 qwen3_5 家族即可复用模板；PR #10227 已处理 visual part 注册。

### 2.2 peft / QLoRA（bitsandbytes 4bit）与线性注意力层的兼容性

**结论：纯 LoRA 有公开实证；QLoRA 4bit 有两处独立来源的明确负面证据，未见成功公开案例。**

负面证据（QLoRA 4bit）：

1. **Unsloth 官方文档**（[Qwen3.5 Fine-tuning Guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune)）：
   - "It is not recommended to do QLoRA (4-bit) training on the Qwen3.5 models, **no matter MoE or dense**"（归因于 "higher than normal quantization differences"）。
   - 显存基准："Qwen3.5 bf16 LoRA VRAM use: 0.8B: 3GB • 2B: 5GB • 4B: 10GB • **9B: 22GB** • 27B: 56GB"。
   - Qwen3.5 使用 "custom Mamba Triton kernels"，编译 "can make compilation slower than usual, **especially on T4 GPUs**"（官方文档唯一一处直接点名 T4）。
2. **NVIDIA 开发者论坛实测报告**（[QLoRA on DGX Spark: Qwen3.6-35B-A3B](https://forums.developer.nvidia.com/t/nightly-qlora-on-a-dgx-spark-fine-tuning-qwen3-6-35b-a3b-on-my-own-coding-agent-logs-hobby-project/378311)）：bitsandbytes 无法对该线性注意力混合架构正确做 4bit 量化，`Linear4bit` 跳过约 90% 的层 —— "4-bit 加载" 名不副实，显存收益大打折扣（Qwen3.6 与 Qwen3.5 同属 GDN 混合家族）。

正面/中性证据（LoRA）：

3. **官方博客 LoRA 微调 Qwen3.5-9B 成功**（同上 [blog.llamafactory.net](https://blog.llamafactory.net/en/posts/qwen3_5_finetuning/)）。
4. **本模型（Qwen3.8-9B-Distill）的社区微调谱系存在**：HF 搜索可见 [JamieBradfield/qwen3.8-9b-hermes-function-calling-v1](https://huggingface.co/JamieBradfield/qwen3.8-9b-hermes-function-calling-v1) 及 -real-traces / -balanced / -todo / -tooluse 系列（多数有 GGUF 转换，说明训练确实完成）、[EclipsedStar/Qwen3.8-9B-Distill-heretic-ara-lora](https://huggingface.co/EclipsedStar/Qwen3.8-9B-Distill-heretic-ara-lora)（LoRA adapter）。但**这些微调均未公开训练栈细节，没有任何一条公开记录说明用了 LLaMA-Factory 或 QLoRA 4bit**。
5. **DataCamp 有 Qwen3.5-0.8B 的 QLoRA 教程**（[Fine-Tuning Qwen3.5 Small With QLoRA](https://www.datacamp.com/tutorial/fine-tuning-qwen3-5-small)）—— 小模型跑通的旁证，不能外推到 9B + T4。

版本坑（FLA 侧）：

6. [flash-linear-attention issue #792](https://github.com/fla-org/flash-linear-attention/issues/792) — "[Bug] Qwen3.5-4B answer '!!!!!!!!!' when using flash-linear-attention 0.5.0"（已关闭）。训练/推理所绑定的 FLA 版本需要 pin 并回归测试。

vLLM 侧 LoRA 生态佐证：v0.20.0 "Qwen3.5 / Step3.x expert base_layer extension ([#37114](https://github.com/vllm-project/vllm/pull/37114))"、v0.21.0 "Qwen3.5 LoRA fusion fix ([#37912](https://github.com/vllm-project/vllm/pull/37912))"（见 [v0.20.0](https://github.com/vllm-project/vllm/releases/tag/v0.20.0) / [v0.21.0](https://github.com/vllm-project/vllm/releases/tag/v0.21.0) release notes）。

### 2.3 flash-linear-attention / causal-conv1d 的 GPU 支持矩阵（T4 = SM75？）

**结论：T4 (SM75) 不在官方支持矩阵内（大概率可跑但未验证、未声明）；P100 (SM60) 基本出局。**

flash-linear-attention（[fla-org/flash-linear-attention](https://github.com/fla-org/flash-linear-attention)）：

1. README："All implementations are platform-agnostic and **verified on NVIDIA, AMD, and Intel hardware**"；自我定位为 "A **Triton-Based** Library for Hardware-Efficient Implementations of Linear Attention Mechanism"；Gated DeltaNet 实现位于 [fla/ops/gated_delta_rule](https://github.com/fla-org/flash-linear-attention/tree/main/fla/ops/gated_delta_rule)。
2. **CI 覆盖**（[.github/workflows](https://github.com/fla-org/flash-linear-attention/tree/main/.github/workflows)）：NVIDIA 仅 `nvidia-h100.yml`（SM90），另有 AMD MI300、Intel B580、华为 Ascend。**没有任何 SM75 (Turing/T4) 的 CI 或官方声明**。
3. **依赖链是硬约束**（[pyproject.toml](https://github.com/fla-org/flash-linear-attention/blob/main/pyproject.toml)）：`[cuda]` extra = `torch>=2.7.0, triton>=3.3`；基础依赖 `transformers>=4.45.0`；`conv1d` extra = `causal-conv1d>=1.4.0`（可选，FLA 自带 Triton 版短卷积实现）。
4. **Triton 门槛**：[Triton v3.3.0](https://github.com/triton-lang/triton/blob/v3.3.0/README.md)、v3.4.0、v3.5.0、main 分支 README 均写 "Supported Hardware: NVIDIA GPUs (**Compute Capability 8.0+**)"；v3.2.0 及更早才是 "Compute Capability 7.0+"。→ **FLA 官方依赖链（triton>=3.3）与 T4 (CC 7.5) 不兼容**。降级 Triton 到 3.2 会违反 FLA 的 `triton>=3.3` 声明，且未见任何人公开验证过该组合。
5. **fp16/bf16**：模型 `dtype: bfloat16`（T4 无原生 bf16）；FLA 有 "[Feature Request] Half Precision fp16 support"（[#763](https://github.com/fla-org/flash-linear-attention/issues/763)，已关闭）及多个 "avoid fp16 overflow" 的修复 PR，说明 fp16 路径存在但易溢出，算子围绕 bf16 设计。

causal-conv1d（[Dao-AILab/causal-conv1d](https://github.com/Dao-AILab/causal-conv1d)）：

6. CUDA 11.6+（版本检查 bug 见 [issue #49](https://github.com/Dao-AILab/causal-conv1d/issues/49)）；官方预编译 wheel 通常不含 sm75，T4 上一般需源码编译（`TORCH_CUDA_ARCH_LIST="7.5"`）；bf16 非原生。**但注意**：FLA 将 causal-conv1d 列为**可选** extra（自带 Triton conv1d），训练侧并非硬依赖。
7. 模型卡（[模型 README](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/blob/main/README.md)）："A recent `transformers` release with Qwen3.5 support is required, along with the Gated DeltaNet kernels (`flash-linear-attention` and a CUDA-matched `causal_conv1d` build) — **without them the linear-attention layers fall back to slow, memory-hungry PyTorch ops**." → T4 上若内核装不上，回退路径功能可用但显存/速度不可接受（9.65B 全量权重 bf16 ≈ 19.3GB，单卡 16GB 必 OOM）。

Kaggle 环境侧：

8. **P100 已被现代 PyTorch 抛弃**：PyTorch CUDA 12.4+ 轮子弃用 Pascal (sm_60)，Kaggle 2026 年环境上 P100 报 "sm_60 is not compatible with the current PyTorch installation"（[PyTorch 论坛](https://discuss.pytorch.org/t/getting-an-error-while-running-my-code-on-p100-gpu-on-kaggle/224730)、[Kaggle/docker-python #1546](https://github.com/Kaggle/docker-python/issues/1546)、[Kaggle 产品反馈](https://www.kaggle.com/product-feedback/683652)）。T4 (sm_75) 仍是 Kaggle "GPU T4 x2" 选项且与 CUDA 12.x PyTorch 兼容（[Kaggle T4×2 公告](https://www.kaggle.com/product-feedback/361104)）。

**未找到**：FLA 官方对 SM75 的任何支持/不支持声明；fla 仓库 issues 中搜 "T4 / sm75" 无直接命中（仅有无关结果）→ T4 可跑性属于**未验证**状态。

### 2.4 vLLM 对 Qwen3.5（混合线性注意力）的服务支持与 hermes parser

**结论：支持。家族级支持自 v0.17.0；本模型这类 text-only dense 检查点需 v0.27.0+，建议 v0.28.0+。hermes parser 是 Qwen 系标准做法，但有已知 bug 需在部署票中回归。**

1. **[vLLM v0.17.0（2026-03-07）](https://github.com/vllm-project/vllm/releases/tag/v0.17.0)**："**Qwen3.5 Model Family**: Full support for the Qwen3.5 model family (#34110) featuring **GDN (Gated Delta Networks)**, with FP8 quantization, MTP speculative decoding, and reasoning parser support."
2. **[v0.18.0（2026-03-20）](https://github.com/vllm-project/vllm/releases/tag/v0.18.0)**：修复 "Qwen3.5 tool calling ([#36774](https://github.com/vllm-project/vllm/pull/36774))"。
3. **[v0.27.0（2026-08-10）](https://github.com/vllm-project/vllm/releases/tag/v0.27.0)**："More new models: **Qwen3.5 text-only dense and MoE models** (#50210)" —— 本模型 config 为 `text_config.model_type: qwen3_5_text` 的 text-only dense，属于这一档。
4. **[v0.28.0（2026-08-26）](https://github.com/vllm-project/vllm/releases/tag/v0.28.0)**："Qwen3.5 **fixes for text-only checkpoints** (#50734, #50355)" + "fused CUDA post-conv MTP decode kernel for Qwen3.5 GDN"。模型发布于 2026-08-16，晚于 v0.27.0，因此 **vLLM >= 0.28.0 是当前稳妥下限**。
5. **tool parser**：Qwen 官方文档推荐 Hermes-style tool use（[Qwen Function Calling](https://qwen.readthedocs.io/en/latest/framework/function_call.html)）；[vLLM Tool Calling 文档](https://docs.vllm.ai/en/stable/features/tool_calling/) 列出 hermes parser 适用 Qwen 系；社区对 Qwen3.5 的标准 serve 命令即 `--enable-auto-tool-choice --tool-call-parser hermes`（例：[n8n 社区帖](https://community.n8n.io/t/mcp-vllm-qwen3-5-model/281128)）。架构层面（GDN 混合注意力）与 tool parser（纯文本后处理层）正交，**未发现二者冲突的报告**。
6. **已知问题（部署票回归项）**：
   - hermes parser **streaming 模式**解析失败返回原文：[vllm #31871](https://github.com/vllm-project/vllm/issues/31871)。
   - 开 `--reasoning-parser` 时 thinking 模式下产生非标准 tool call：[vllm #42021](https://github.com/vllm-project/vllm/issues/42021)。
   - [vllm #35238](https://github.com/vllm-project/vllm/issues/35238) — "Qwen3.5-27B dtype mismatch in DeltaNet layers during torch.compile (float != c10::Half)"（2026-03-01 已关闭）——量化权重 + torch.compile 组合的 DeltaNet 层问题，部署时若开 compile/量化需验证。
7. **模型卡背书**："These artifacts are compatible with Hugging Face Transformers, vLLM, SGLang, and other standard runtimes with Qwen3.5 architecture support."（[模型 README](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/blob/main/README.md)）
8. **部署 GPU 提醒**：vLLM 官方最低 Compute Capability 7.0，但结合 2.3 节 Triton 3.3+/FLA 系内核 CC 8.0+ 的约束，GDN 混合架构在 T4 上跑 vLLM 属未验证；且 9.65B bf16 权重 ≈19.3GB 本身就放不进 16GB 卡。部署票需明确目标 GPU（≥SM80、≥24GB）。

### 2.5 社区实证（HF 模型页 Discussions 与量化版本）

**结论：推理栈可用性有充分旁证（官方 GGUF 43 万下载、MLX、GPTQ）；无 LLaMA-Factory/QLoRA 训练报告；模型仓库命名/信誉在社区有争议；官方 chat template 有 bug。**

16 条 Discussions 全量枚举（2026-08-16 ~ 2026-09-03，来源：[discussions 页](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/discussions)）：

| # | 标题 | 性质 |
|---|------|------|
| 1 | How did you create a good distillation dataset? | 蒸馏数据集提问 |
| 2 | URGENT: Update the Title to Include Unofficial or Distilled | 命名批评（8 评论） |
| 3 | Literally doesn't fail tool calls | 正面：原生 tool calling 几乎不失败 |
| 4 / 8 | Report | spam 举报 |
| 5 | 🚩 Report: Spam | 举报 + 关键评论（见下） |
| 6 / 9 / 10 / 12 / 14 | 🚩 Report: Spam | spam 举报 |
| 7 | LOL | 调侃 |
| 11 | 为了骗点击脸都不要了😅 | 批评 |
| 13 | 恶意发布 | 批评 |
| 15 | Jinja Script not good | **官方 chat template 有 bug** |
| 16 | Apology for earlier claims in fine tunes! | 微调者公开纠错（见下） |

关键内容：

1. **命名争议**（[#5](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/discussions/5)，获 9 个 👍）："The way the repo is named suggests that this is the official Qwen3.8-9B model - it is not; **it is Qwen3.5-9B that is finetuned with traces from 3.8**"。这与模型卡自述（将 "Qwen3.8 2.4T A95B" 教师蒸馏进 Qwen3.5-9B 架构）一致：**架构=Qwen3.5-9B（GDN 混合），权重是蒸馏产物**。约 10/16 条讨论为举报/批评，仓库信誉需在 ADR 中注明。
2. **原生 function calling 可信**：[#3](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/discussions/3) 实测 tool call 失败后均可自愈；[#16](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/discussions/16) 微调者因自建评测 harness 错误（把 schema 烘进 system 文本、解析 XML 而非走原生 tools 参数）误判后公开道歉："re-tested properly against the native interface, the un-tuned base model aced the tool-firing battery (**18/20 tier-1**) right out of the box"。
3. **官方 chat template 有 bug**（[#15](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/discussions/15)）："The script seems very faulty. Proper logic is not in place to handle closures."；社区修复方案：[froggeric/Qwen-Fixed-Chat-Templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates/blob/main/chat_template.jinja)。**训练与部署前必须核对 distill 仓库的 `chat_template.jinja`，必要时替换为 Qwen/Qwen3.5-9B 官方模板**（LLaMA-Factory 训练侧用自己的 `qwen3_5` 模板，不受仓库 jinja 影响，但两边格式一致性要人工确认）。
4. **量化版本存在（推理栈旁证）**（来源：[HF 模型搜索](https://huggingface.co/models?other=base_model:quantized:empero-ai/Qwen3.8-9B-Distill)）：
   - 官方 [empero-ai/Qwen3.8-9B-Distill-GGUF](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill-GGUF)（431,145 下载，2026-09-06 查询）→ **llama.cpp 已可跑该架构**；
   - MLX 4/5/6/8-bit（keXjos、SiddhJagani 等）、NVFP4-GGUF（Noobito45、luxuansang）、MTP-GGUF（srmiles）；
   - **GPTQ int4**：[malvavisc0/Qwen3.8-9B-gptq-int4](https://huggingface.co/malvavisc0/Qwen3.8-9B-gptq-int4)（基于姊妹仓库 empero-ai/Qwen3.8-9B，同为 Qwen3.5 架构）；
   - **未发现 AWQ 版本**（检索范围内）。
5. **未找到**：任何人报告用 LLaMA-Factory（尤其 QLoRA 4bit）训练该模型的公开记录；FLA/peft 仓库中针对本模型的 issue。

---

## 3. Go / No-Go 建议

### 3.1 训练：Kaggle T4×2 + LLaMA-Factory QLoRA 4bit —— **No-Go（当前形态）**

三重独立证据叠加，每一重单独都足以否决：

1. **内核层**：FLA 官方 `[cuda]` extra 要求 `triton>=3.3`，Triton 3.3+ 官方只支持 CC 8.0+；T4 (SM75) 上内核装不上/不受支持 → 回退 "slow, memory-hungry PyTorch ops"（模型卡原话），9.65B bf16 权重 ≈19.3GB > 16GB 单卡 → OOM。
2. **量化层**：Unsloth 官方明确不建议对 Qwen3.5（无论 dense 还是 MoE）做 QLoRA 4bit；NVIDIA 论坛实测 bitsandbytes `Linear4bit` 会跳过该架构约 90% 的层 → 4bit 加载的实际显存可能仍逼近全量，16GB 更放不下，且量化训练质量存疑。
3. **显存层**：即便绕过前两条，9B 的 bf16 LoRA 需要 ≈22GB（Unsloth 数据）> 16GB；T4×2 的 DDP 每卡仍是全量权重。P100 备选被 PyTorch CUDA 12.4+ 弃用 Pascal 直接判死。

**回退条件与替代路径**（按优先级）：

- **R1（推荐回退）**：回到 Qwen3-8B 原计划（dense softmax attention，LLaMA-Factory + QLoRA 4bit 在 T4 上是成熟组合），或等算力到位再迁 Qwen3.5 家族。
- **R2**：若坚持 Qwen3.5 家族，降到 **Qwen3.5-4B**（bf16 LoRA ≈10GB，T4 16GB 单卡尺寸可行）——但 Triton/FLA 的 SM75 约束仍在，需先跑通 5 分钟冒烟（见下）再立项；Qwen3.5-0.8B/2B（3GB/5GB）更稳。
- **R3**：换算力：单卡 ≥24GB（L4/RTX 4090/3090）做 bf16 LoRA（22GB 贴边，需梯度 checkpointing）；或 A100 40GB（Kaggle 之外）从容做 LoRA。QLoRA 在该架构上即使显存够也不推荐。
- **R4（不推荐）**：Colab T4 同样受 SM75 约束，不是出路。

**若仍要在 T4 上实测（R2 前置冒烟，≈30 分钟内可证伪）**：

```bash
# 1) 内核可用性
python -c "import torch; print(torch.cuda.get_device_capability())"          # 期望 (7,5)
pip install "flash-linear-attention[cuda]"                                    # 观察 triton>=3.3 解析与安装
python -c "from fla.ops.gated_delta_rule import chunk_gdn; print('fla ok')"  # 期望不报 CC 错
# 2) bitsandbytes 覆盖率
# 加载模型(4bit)后检查 GDN/linear 层是否真的变成 Linear4bit（预计被跳过 ~90%）
# 3) LLaMA-Factory 冒烟：template qwen3_5 + 100 样本 + cutoff 1024，看 loss 是否正常下降
```

### 3.2 部署：vLLM `--tool-call-parser hermes` —— **有条件 Go（后续票执行）**

架构支持链完整（v0.17.0 家族支持 → v0.27.0 text-only dense → v0.28.0 修复），tool parser 标准做法明确。**部署票必须验证的清单**：

1. **版本下限 vLLM >= 0.28.0**（text-only checkpoint 修复 [#50734/#50355](https://github.com/vllm-project/vllm/releases/tag/v0.28.0)）；加载 `empero-ai/Qwen3.8-9B-Distill` 冒烟。
2. **部署 GPU ≥ SM80 且 ≥24GB**（GDN 内核与 Triton 3.3+ 约束；9.65B bf16 权重 19.3GB）。T4 上跑 vLLM 不在计划内。
3. **`--enable-auto-tool-choice --tool-call-parser hermes`** + **streaming 模式回归**（[#31871](https://github.com/vllm-project/vllm/issues/31871) 已知 streaming 解析 bug）。
4. 若启用 thinking + `--reasoning-parser`，验证与 hermes 共存（[#42021](https://github.com/vllm-project/vllm/issues/42021)）；若开 torch.compile/量化，回归 [#35238](https://github.com/vllm-project/vllm/issues/35238) 类 DeltaNet dtype 问题。
5. **chat template 核对**：distill 仓库 Jinja 被报 buggy（[#15](https://huggingface.co/empero-ai/Qwen3.8-9B-Distill/discussions/15)）→ 对比 [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) 官方模板或 [froggeric 修复版](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates/blob/main/chat_template.jinja)，并确认与训练侧 LLaMA-Factory `qwen3_5` 模板格式一致。
6. **SFT adapter 与 vLLM LoRA**：合并权重优先；若动态加载 LoRA，需 vLLM ≥ v0.21.0（Qwen3.5 LoRA fusion fix [#37912](https://github.com/vllm-project/vllm/pull/37912)）并回归。
7. **FLA/依赖版本 pin**：训练与推理环境记录 FLA 具体版本（有 [#792](https://github.com/fla-org/flash-linear-attention/issues/792) 类输出版本 bug 前科）。

### 3.3 附加风险提示（ADR 应记录）

- 模型仓库为**社区蒸馏产物**（非 Qwen 官方），命名有误导性、社区争议大（16 条讨论约 10 条举报/批评）；权重质量只有模型卡自述 benchmark 与零散用户口碑（tool calling 好评）背书。**建议在合并 adapter 前后都跑一套自有评测基线**。
- 训练侧 function calling 格式：LLaMA-Factory `qwen3_5` tool_format 与 vLLM `hermes` parser 的序列化格式需做一次端到端对拍（训练样本渲染 → 推理解析回环）。

---

## 4. 调研日期与检索范围声明

**日期**：2026-09-06。

**已查渠道**：

- GitHub：hiyouga/LLaMA-Factory（releases、main 分支 `template.py` / `constants.py` / `pyproject.toml` raw 文件、issues #10221/#10270）、fla-org/flash-linear-attention（README raw、pyproject.toml、.github/workflows、issues #763/#792、issue 搜索）、vllm-project/vllm（releases API 近 40 个版本全文 grep、issue #35238）、triton-lang/triton（v3.0.0~v3.5.0 及 main 的 README）、Dao-AILab/causal-conv1d（issue #49）、Kaggle/docker-python（issue #1546）。
- Hugging Face：empero-ai/Qwen3.8-9B-Distill（模型卡 raw、config.json raw、discussions API 全量 16 条、#1/#3/#5/#15/#16 详情）、HF models API（`search=Qwen3.8-9B` 前 60 条，量化衍生品盘点）。
- Web 检索（中英文）：LLaMA-Factory Qwen3.5 支持、flash-linear-attention T4/SM75、vLLM Qwen3.5 GDN、Qwen3.5 QLoRA bitsandbytes、causal-conv1d T4、Triton 最低算力、Kaggle T4/P100 CUDA 环境、vLLM Qwen3.5 hermes tool parser。
- 二手源交叉引用：Unsloth 官方文档（Qwen3.5 微调页）、LLaMA-Factory 官方博客（Qwen3.5-9B 微调教程）、Qwen 官方文档（function calling）、NVIDIA 开发者论坛、vLLM 官方 Tool Calling 文档、腾讯云开发者社区（v0.9.5 解读，与 GitHub release 原文核对一致）。

**未找到 / 未覆盖（如实声明）**：

1. flash-linear-attention 对 SM75/T4 的任何官方支持或排除声明（issues 搜索无命中）→ T4 可跑性**未验证**。
2. 任何人用 LLaMA-Factory（QLoRA 4bit）训练 empero-ai/Qwen3.8-9B-Distill 的公开报告 → **未找到证据**。
3. 该模型的 AWQ 量化版本 → 未发现（GPTQ/GGUF/MLX/NVFP4 有）。
4. LLaMA-Factory issue #10270 的最终解决结论（issue 开放时抓取，正文在报错贴出前被截断）。
5. Kaggle 当前镜像的精确 CUDA/torch 版本号（依赖社区帖子佐证 T4/CUDA 12.x 兼容、P100 已被弃用；建议在 Kaggle 实机打印 `torch.version.cuda` 与 `torch.cuda.get_arch_list()` 确认）。
6. GitHub REST API 部分调用遭限流（403），改用经认证的 `gh` CLI 完成 #35238/#792/#763 的标题与状态核实；issue 正文的逐字引用以检索摘要 + URL 为准，均已给出可点开核对的原链。
