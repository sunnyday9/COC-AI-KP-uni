# KP 金样本评测（T3 #39 / spec #36）

三层评测（格式遵循 ≥99% / 金样本裁定 ≥90% / 人工盲评）的前两层自动化资产，**先于训练存在**（#42 gate 依赖本票 + #41）。

## 构成

- `golden-samples.json` — 57 条标准情境 → 期望工具/参数，覆盖 24 个 COC 工具主组合（覆盖度由 `toolCoverage` 校验）。情境人工编写：mini 剧本「雾停镇的灯塔」+ 规则书规则场景；含多人合并批次（D4/D5）、工具循环续接、纯叙事负例、「别骰了直接说结果」格式陷阱。
- `characters.json` — 角色卡单点定义（数值自洽：hp=(CON+SIZ)/10、mp=POW/5、DB/体格/MOV 按三围表），样本以 `characters[]` 引用。
- `lib/` — 判定与请求构建：
  - 规则单源：格式遵循的判定直接复用 `shared/tools/kpValidation.ts`（与 server `kpGraph.ts` validate 节点同一份：required 工具等价展开 / 文字模拟骰子正则），评测器与产品零漂移；
  - 请求同构：`lib/request.ts` 复用 server 提示词纯函数（`kpPromptService.buildRoomTurnMessages` + `injectCharacterRoster`）+ 按线上形态回放工具结果（`【结果摘要】`+JSON 截断回填）；
  - `lib/judge.ts` 产出双指标（格式遵循率/裁定正确率）与可分类失败明细：`no_tool_call`（未调工具）/ `wrong_tool`（调错工具）/ `bad_args`（参数错）/ `text_dice`（文字骰点）/ `unparseable`（未知工具名或参数非 JSON，属格式层，对应「调错工具」的解析子类）。
- `run-eval.ts` — CLI：任意 openai_chat 端点 → 报告 JSON（两数字 + 明细 + 24 工具覆盖 + tokens）。
- `reports/` — 基线与历次报告落盘（gate 对照基准）。当前基线：`baseline-mimo-v2.5-2026-09-05.json`（mimo-v2.5 @ opencode，格式遵循 80.7% / 裁定正确 63.2%，57/57 判定，明细含 `search_memory` 幻视工具名等）。
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
```

参数：`--concurrency`（默认 4）、`--limit N`（冒烟）、`--temperature`（默认 0.7，与 server openai_chat 适配器默认一致）、`--max-tokens`（默认 2048）。

## 期望参数的判定尺度（人工复核约定）

只强制**规则/剧本可判定**的参数：技能值（来自角色卡）、tieBreaker（反击=attacker/闪避=defender）、灵感检定难度反转、射程难度、奖励/惩罚骰的规则强制项、损失表达式与法术消耗（剧本给定）、sceneId/clueId（剧本结构化 id）、多人 characterId（花名册要求）。KP 自由裁量项（普通检定难度、叙事措辞）不进匹配；近战/远程允许「一步结算工具或分步链」两条备选序列。每条样本的 `notes` 记录依据。

判定尺度补充（与线上行为对齐）：
- 响应中混入**任一**未知工具名或 arguments 非 JSON 对象 → 整样本记 `unparseable`，双指标皆败——线上客户端按工具名校验、未知工具会中断回合，一票否决是忠实模拟；
- 空/空白 arguments 按线上 openaiChat 适配器同规则归一为 `{}`（随后因缺参数在裁定层判 `bad_args`，不会漏判）；
- 失败明细里 `wrong_tool` 有两种格式位形态：`formatOk:false`（required 未覆盖，对应「调错工具」）与 `formatOk:true`（纯叙事情境多调了工具，属裁定层错）。

## 基线报告

当前基线 `reports/baseline-mimo-v2.5-2026-09-05.json`：**格式遵循 80.7% / 裁定正确 63.2%**（57/57 判定，0 端点错误；bad_args 10 / wrong_tool 7 / unparseable 1 / no_tool_call 2 / text_dice 1；含 `search_memory` 幻视工具名、chase_turn 用 skill_check/melee_attack 替代、多人漏 characterId 等真实失败样本）。端点 = 用户当前 BYOK KP 配置（opencode `mimo-v2.5`，temperature 0.7 / max_tokens 2048，与 server 适配器默认一致），报告内含 baseUrl/model 可复核；这是 #42 gate（格式 ≥99% / 裁定 ≥90%）的对照基准。

## 工程边界

- 独立工作区：零 npm 依赖，Node ≥24 原生 TS（type stripping）+ `--import` resolve hook（`.js`→`.ts`，仅为复用 server 源码）；不进 server 运行时依赖树，产品行为零改动。
- `--import` 的路径必须带 `./` 前缀（裸包名会被当包解析）。
- 本目录（eval/）不在 `training/` 的 tsconfig/vitest 范围内（那是 T2 数据导出器 #38 的地盘）；评测自测走 node:test，互不干扰。
