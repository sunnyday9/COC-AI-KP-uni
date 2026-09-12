# KP 金样本评测（T3 #39）

三层评测（格式遵循 ≥99% / 金样本裁定 ≥90% / 人工盲评）的前两层自动化资产，**先于训练存在**。原用途是自训 KP 模型的 #42 gate；2026-09-12 自训方向放弃（#36/#42/#43 关闭，见 `.out-of-scope/self-trained-kp-model.md`）后，本 harness 转作 **BYOK 端点的质量基线**——换模型/改提示词后重跑一遍即得可比数字。

## 构成

- `golden-samples.json` — 57 条标准情境 → 期望工具/参数，覆盖 24 个 COC 工具主组合（覆盖度由 `toolCoverage` 校验）。情境人工编写：mini 剧本「雾停镇的灯塔」+ 规则书规则场景；含多人合并批次（D4/D5）、工具循环续接、纯叙事负例、「别骰了直接说结果」格式陷阱。
- `characters.json` — 角色卡单点定义（数值自洽：hp=(CON+SIZ)/10、mp=POW/5、DB/体格/MOV 按三围表），样本以 `characters[]` 引用。
- `lib/` — 判定与请求构建：
  - 规则单源：格式遵循的判定直接复用 `shared/tools/kpValidation.ts`（与 server `kpGraph.ts` validate 节点同一份：required 工具等价展开 / 文字模拟骰子正则），评测器与产品零漂移；
  - 请求同构：`lib/request.ts` 复用 server 提示词纯函数（`kpPromptService.buildRoomTurnMessages` + `injectCharacterRoster`）+ 按线上形态回放工具结果（`【结果摘要】`+JSON 截断回填）；
  - `lib/judge.ts` 产出双指标（格式遵循率/裁定正确率）与可分类失败明细：`no_tool_call`（未调工具）/ `wrong_tool`（调错工具）/ `bad_args`（参数错）/ `text_dice`（文字骰点）/ `unparseable`（未知工具名或参数非 JSON，属格式层，对应「调错工具」的解析子类）。
- `run-eval.ts` — CLI：任意 openai_chat 端点 → 报告 JSON（两数字 + 明细 + 24 工具覆盖 + tokens）。
- `reports/` — 基线与历次报告落盘。当前基线：`baseline-mimo-v2.5-20260912.json`（M1 提示词改革后刷新）。
- `test/` — 判定器/请求构建/金样本集守卫的自测（node:test，21 条）。

## 用法

```bash
# 自测（无需端点）
node --import ./training/eval/register-ts.ts --test "training/eval/test/*.test.ts"

# 列出样本与覆盖（无需端点）
node --import ./training/eval/register-ts.ts training/eval/run-eval.ts --list

# 跑评测（凭据：--api-key 或 EVAL_API_KEY；端点/模型：--endpoint/--model 或 EVAL_BASE_URL/EVAL_MODEL）
EVAL_API_KEY=sk-... node --import ./training/eval/register-ts.ts training/eval/run-eval.ts \
  --endpoint https://api.example.com/v1 --model qwen3-8b \
  --tag qwen3-8b-sft-r1 --out training/eval/reports/qwen3-8b-sft-r1.json

# opencode zen 网关要求 x-opencode-session 头才路由（--session 或 EVAL_SESSION/OPENCODE_SESSION）
OPENCODE_SESSION=eval-$(date +%Y%m%d) EVAL_API_KEY=... node --import ./training/eval/register-ts.ts \
  training/eval/run-eval.ts --endpoint https://opencode.ai/zen/go/v1 --model mimo-v2.5 \
  --tag mimo-$(date +%Y%m%d) --out training/eval/reports/mimo-$(date +%Y%m%d).json
```

参数：`--concurrency`（默认 4）、`--limit N`（冒烟）、`--temperature`（默认 0.7，与 server openai_chat 适配器默认一致）、`--max-tokens`（默认 2048）。

## 期望参数的判定尺度（人工复核约定）

只强制**规则/剧本可判定**的参数：技能值（来自角色卡）、tieBreaker（反击=attacker/闪避=defender）、灵感检定难度反转、射程难度、奖励/惩罚骰的规则强制项、损失表达式与法术消耗（剧本给定）、sceneId/clueId（剧本结构化 id）、多人 characterId（花名册要求）。KP 自由裁量项（普通检定难度、叙事措辞）不进匹配；近战/远程允许「一步结算工具或分步链」两条备选序列。每条样本的 `notes` 记录依据。

判定尺度补充（与线上行为对齐）：
- 响应中混入**任一**未知工具名或 arguments 非 JSON 对象 → 整样本记 `unparseable`，双指标皆败——线上客户端按工具名校验、未知工具会中断回合，一票否决是忠实模拟；
- 空/空白 arguments 按线上 openaiChat 适配器同规则归一为 `{}`（随后因缺参数在裁定层判 `bad_args`，不会漏判）；
- 失败明细里 `wrong_tool` 有两种格式位形态：`formatOk:false`（required 未覆盖，对应「调错工具」）与 `formatOk:true`（纯叙事情境多调了工具，属裁定层错）。

## 基线报告

当前基线 `reports/baseline-mimo-v2.5-20260912.json`：**格式遵循 77.2% / 裁定正确 57.9%**（57/57 判定，0 端点错误；wrong_tool 12 / bad_args 10 / no_tool_call 2）。与上一基线（2026-09-05：80.7% / 63.2%，bad_args 10 / wrong_tool 7 / unparseable 1 / no_tool_call 2 / text_dice 1）相比：unparseable/text_dice 清零（格式层改善）、wrong_tool +5——总分差 ≈2-3 条样本，在 temperature 0.7 单跑噪声带内，且 M1 提示词改革改动了知识块措辞，与模型侧漂移不可区分；以本基线为 M1 后参照，换模型/改提示词后同参重跑对比。端点 = 用户当前 BYOK KP 配置（opencode `mimo-v2.5`，temperature 0.7 / max_tokens 2048，与 server 适配器默认一致，经 `x-opencode-session` 头路由），报告内含 baseUrl/model 可复核。

## 工程边界

- 独立工作区：零 npm 依赖，Node ≥24 原生 TS（type stripping）+ `--import` resolve hook（`.js`→`.ts`，仅为复用 server 源码）；不进 server 运行时依赖树，产品行为零改动。
- `--import` 的路径必须带 `./` 前缀（裸包名会被当包解析）。
- 本目录（eval/）不在 `training/` 的 tsconfig/vitest 范围内（那是 T2 数据导出器 #38 的地盘）；评测自测走 node:test，互不干扰。
