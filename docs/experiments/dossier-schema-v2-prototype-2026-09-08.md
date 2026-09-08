# dossier schema v2 + 重建测试原型（早八要迟到了 / 巫女）——实验记录

> 2026-09-09 凌晨（实验分支 feature/kp-dossier-workflow，P12）。
> 背景：真实 A/B（见 dossier-vs-rag-real-2026-09-08.md）暴露三件事——(a) "对局后 5 问追问"探针系统性失效（KP 把追问当行动输入，两房 1.6/1.58 分、~60% fab）；(b) dossier 房知识缺失时表现为**否认内容存在**（比 rag 编造更误导）；(c) 档案生成质量不均且**不可验证**（早八要迟到了 v1 档案生成直接失败仍参战；重返黑色校园 18.5k 字符只抽 3 场景无告警）。
> 本原型回答：schema v2（图关系层）+ "档案直答"重建测试能否把"档案完整度"变成可测指标，并支撑"凭档案反推剧情/时间线/关系/场景切换"。

## 方法

- **schema v2**：StoryDossier 增加 `transitions[]`（场景切换边 from/to/condition/viaClues）、`events[]`（时间线，数组序=剧情先后，含 when/summary/scene/critical）、`npc.relations[]`（关系边 target/type/note）、`meta.timeframe/premise/background`。跨批引用用**名字**，合并后 `resolveRefs` 按名字归一化为 id；`assessDossier` 输出结构质量：孤儿边/关系/事件引用、sceneText 覆盖率（sceneText 总字数/剧本字数）、分节失败提示——全部只告警不阻断。
- **生成预算修复**：v2 每节输出变重（+事件/关系/边），推理模型 reasoning 吃掉 output budget → 8k maxTokens 下 5 节挂 3 节（解析空×4 重试仍失败）；提到 **16384** 后全节成功。
- **重建测试 = 档案直答探针**（不经对局）：把整份档案 JSON 放入 context，让 LLM 以"档案问答器"身份逐问作答（档案没有就如实说"档案中无此信息"）；judge 对照剧本原文引证(refQuote) 打 1-5 + fabrication。探针 = 旧 5 问（可对比 v1 在场分）+ 新分类问（timeline/relation/scene-graph/detail/truth）。
- 数据：`training/eval/reports/ab-reconstruct-20260908.json`（首轮，巫 为 8k 坏档）、`-20260908b.json`（巫 16k 修复档）、`-20260908c.json`（早八探针补跑）；v2 档案落盘 `training/eval/dossier-cache/1/`（gitignored）。
- 驱动：`scripts/eval/ab-reconstruct.mjs`（--keys=… --skip-gen=1 复用缓存档案只跑探针）。

## 结果

### 档案生成质量（v1 vs v2）

| 剧本 | v1（对局用） | v2 首轮(8k) | v2 修复(16k) |
|---|---|---|---|
| 早八要迟到了（16.6k 字符） | **ok:false**（batch 2/2 解析空）→ 半档参战 | ok：14 场景/30 线索/14 NPC/13 边/10 事件，覆盖率 21.1%，1 孤儿事件引用 | 同（复用） |
| 巫女（45.8k 字符） | ok：22/31/18（无 events/relations/coverage 概念） | ok 但 **3/5 节解析空**：12/14/11/10 边/7 事件，覆盖率 2.9%，孤儿边 3/关系 4 | ok：**27/60/25 NPC/22 边/28 事件**，覆盖率 35.4%，孤儿边 3/关系 3/事件 4 |

质量门把 v1 时代不可见的失败变成了显式告警：分节失败数、覆盖率%、孤儿引用清单全部出现在 generate 响应（warnings）。巫 8k 坏档的覆盖率 2.9% 直接命中"疑似严重欠抽"告警线。

### 档案直答探针（v2 修复档；1-5 分，judge 对照原文）

**早八要迟到了：avg 3.38（judged 8/8，fab 0）** — v1 档案在场分：生成失败、5 问全 1（4 fab）

| 探针 | v2 直答 | 说明 |
|---|---|---|
| 10/25 教学楼门口异常（fact） | 4 | 引 scene_campus 描述作答 |
| 逐日工程建筑与事件关系（fact） | 5 | 全中 |
| 患病物理教授是谁（fact） | 1* | **空响应 flake（推理吃光 budget），非档案缺口**——同内容经 relations 问得 3 |
| "疫情"真相（fact） | 3 | 真相在 meta.background + events，细节有损 |
| 驱逐星之彩的方法（fact） | 3 | 步骤全中（clue_coils_and_wire 原文引用），缺"夜间蓝紫光"等 sceneText 压缩细节 |
| 星之彩何时经何途径抵达（timeline） | 5 | events[9/23] 直接命中 |
| 李建业与两学生的师生关系（relation） | 3 | relations 边命中 |
| 线圈+辐射中心位置（scene-graph） | 3 | 引 scene_solaris_lab 原文，细节不全 |

**巫女：avg 2.78（judged 9/9，fab 1）** — v1 档案在场分：1.0（4/5 fab，含否认天野杏存在）；v2 8k 坏档直答 1.22（7/9 如实"无此信息"）

| 探针 | v2 直答 | v1 在场 | 说明 |
|---|---|---|---|
| 时间地点身份活动（fact） | 3 | 1(fab) | 要点部分命中 |
| 植物园荒地样貌（fact） | 5 | 1 | sceneText 全中 |
| 竹田学其人（fact） | 3 | 1(fab) | 关系边+details |
| 天野杏被困真相（fact） | 3 | 1(fab) | 档案含梗概，细节含糊 |
| 安息方法（fact） | 1 | 1(fab) | **结局层缺口**（旧规则"结局放最后场景"不够） |
| 困 30 年/死因（timeline） | 3 | — | events 有 1990 前后事件，时长表述含糊 |
| 竹田学与神社渊源（relation） | 3 | 1(fab) | relations 命中 |
| 荒地土壤危险性（detail） | 3 | — | 部分细节在 sceneText 压缩中丢失 |
| 安息条件与结果（truth） | 1(fab) | 1(fab) | 结局/仪式细节缺失，回答补了档案外细节 |

## 结论

1. **schema v2 图关系层可用且明显改善覆盖**：早八 13 切换边/10 事件/13 关系/meta 背景；巫 修复后 22 边/28 事件/25 NPC。跨批名字引用 + resolveRefs 归一化工作正常（孤儿引用从"不可见"变成"可数告警"：每篇仅 3-4 条，指向跨批命名漂移/混用 id 与名字，下轮可在 prompt 中要求统一用名字或后处理映射）。
2. **档案直答模式修复了探针缺陷**：在场追问的"答非所问/否认/编造"（v1 fab 4/5、4/5）在直答模式下变成"引档案作答 + 如实报缺口"（早八 fab 0/8，巫 fab 1/9）。同模型同档案，模式差异即行为差异——**"对局后追问"不能用于度量档案知识，直答/重建才测得到覆盖**。
3. **质量门有效**：坏档（巫 8k：覆盖率 2.9% + 3/5 节失败）与修复档差异在 generate 响应里一目了然；下一步 harness 可把 warnings 升级为"覆盖<阈值则禁止参战"。
4. **仍缺一层：结局/真相**。两篇的"安息/收场/真相"类探针得分最低（1-3）——旧规则"结局信息放最后一个场景的 sceneText"在压缩后丢细节。建议加显式 `truths`/`ending` 摘要层（带剧透标记：运行时按需查证才给，评估时直接测）。
5. **细节保真上限 = sceneText 压缩率**：早八 21%/巫 35% 覆盖率下，"细节类"探针普遍 3 分（缺蓝紫光、土壤盛取容器等）。若目标是"反推全部细节"，需要提高每场景 sceneText 配额（成本↑）或接受"结构化层=骨架、细节按场景再查原文"的分层口径（档案保留全文索引更实际）。

## 建议下一步（决策点）

- A. 收尾本实验：保留 schema v2 + 质量门 + 直答探针工具，档案 v2 作为 dossier workflow 的升级（需重生成 10 篇并重跑 dossier 房 ~2.5-3h LLM 预算）；
- B. 先补 truths/ending 层 + prompt 引用规范再批量（多一轮 2 篇小验证）；
- C. 到此为止：结论已足够支撑"档案工作流 + 图关系层 + 覆盖度量"的方向判断，10 篇批量等用户拍板。

## 复现

```bash
# 生成 v2 档案 + 直答探针（真实 LLM；密钥只从环境变量读）
MOCK_AI=0 AB_AI_BASE_URL=$AB_AI_BASE_URL AB_AI_API_KEY=$AB_AI_API_KEY AB_AI_MODEL=mimo-v2.5 \
  OPENCODE_SESSION=xxx node scripts/eval/ab-reconstruct.mjs \
  --keys=早八要迟到了,巫_20220928_nocom --out=training/eval/reports/ab-reconstruct-<ts>.json
# 复用已生成档案只跑探针
node scripts/eval/ab-reconstruct.mjs --skip-gen=1 --keys=<key> --out=...
```
