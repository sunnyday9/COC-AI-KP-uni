# 模组图片的 Vision 处理原型（mimo-v2.5 视觉）——实验记录

> 2026-09-09（实验分支 feature/kp-dossier-workflow，P16）。
> 背景问题："story 中非文字内容（图像）怎么处理的"→ 现状：storyParsers 只 OCR PDF **前 8 张** JPEG/PNG（对象序、无页面锚定、tesseract chi_sim），其余格式图片全丢；实测 10 篇真实模组每篇含 7–577 张内嵌图，图载信息（地图/线索卡/信件）绝大多数进不了 rag/dossier。
> 本原型验证方向 2：**Vision LLM 读图 → 结构化**（脚本 scripts/eval/ab-vision-map.mjs）。

## 能力探测

- **mimo-v2.5 支持视觉**（opencode.ai/zen/go/v1, image_url data URI，200 OK；1x1 PNG 颜色问答正确、封面海报文字转录准确）。
- **mimo-v2.5-pro 不支持**（上游 404 "No endpoints found that support image input"）。
- 上游偶发瞬时 400 / 空响应（reasoning 吃光 budget）→ 需 2-3 次重试 + max_tokens 充足。

## 方法与实测

抽取：pdf-lib 逐页枚举 Resources/XObject 图片 → 解码 JPEG/PNG → 每页至多 2 张、跨页字节去重、按尺寸过滤（≥600×600 或长边≥1000 短边≥400）、排除高宽比 >3.2 横幅条 → top N；--dry 落盘候选 + --pick 指定图跑 vision。

| 剧本 | 候选 | 结果 |
|---|---|---|
| 猫是我（27 页 29 图） | 6 | p1 封面海报（插画，标题文字转录准）；**p17 国民証（线索卡）转录完美**（"田代島にゃんこ共和国国民証"全文）；p27 判"地图"实为**无文字标签平面图**——如实报"无标签"并结构化描述区块（庭院/走廊/楼梯间）+ 抓到一个箭头连接；其余 插画/其他 |
| 巫女（70 页 166 图） | 6 | **p60 标注平面图：5 地点**（卫生间×2/温室展厅/休息区域/配电室/办公楼）；**p61 编号地图：4 地点 + 3 条可达边**（①露营营地→②山崖/③森林/④废弃房屋）；p68 药品说明书全文转录（线索卡）；p2 整页文字转录 279 字；p66/67 空响应 flake |

## 交叉核对（vision 地点 vs 巫 v2.1 档案 26 场景）

| vision 读出 | 档案场景 | 判定 |
|---|---|---|
| 温室展厅 / 休息区域 / 办公楼 | 同名字场景 | ✓ 逐字命中（p60 平面图=办公楼内部分层，卫生间/配电室为子区域） |
| 森林 / 废弃房屋 | 同名字场景 | ✓ 逐字命中（p61） |
| 露营营地 | 「露营区域」 | ⚠ 词面漂移——同一地点两种叫法 |
| 山崖 | 无 | ✗ **档案缺失场景**——图载信息补上了文本抽取的洞 |

## 结论

1. **通道价值分层清晰**：
   - 线索文字图（国民証/药品说明书/信件）→ 转录质量高 → 可作档案"线索卡文本"资产，直接补 clue 层；
   - 标注地图/平面图 → places + connections 结构化可用 → 可直接并入 scenes/transitions（精确名命中 + 词面漂移/缺失场景转告警清单）；
   - 无标签图 → 如实降级为区块描述（低价值，不硬编）。
2. **图载信息确实能补档案缺口**：巫 档案从纯文本抽取已相当完整（26 场景），vision 仍发现 1 个缺失场景（山崖）+ 1 处命名漂移（露营营地/露营区域）+ 平面图子区域粒度。
3. 页面锚定（按页序抽取）解决了旧 OCR 的对象序/无锚问题；每页取大图 + 尺寸过滤比"前 8 张"命中率高得多。

## 建议集成方式（若批量走）

- dossier 生成管线旁路加一步 `map annex`：每剧本抽图候选（≤6）→ vision 一轮 → 产出 annex JSON（`{cards:[{page,transcript}], maps:[{page,places[],connections[]}]}`）与档案同目录落盘；
- 合并策略：places 名与 scenes.name **精确匹配**（漂移项如 露营营地/露营区域 → 收录为场景别名 keywords）；不存在的场景（山崖）→ 告警清单（人工或二次 LLM 决定是否建场景）；connections 名匹配后并入 transitions（来源标 map）；
- 线索卡 transcript → 挂为 clue（"线索卡"类型，location=页码）；
- 运行时查证工具（scene_dossier/lexical_search）把 annex 一并纳入检索面；
- 注意：mimo 视觉用 **mimo-v2.5**（非 -pro）；调用要带重试（空响应 flake）；每剧本 4-6 次 vision 调用成本。

## 复现

```bash
node scripts/eval/ab-vision-map.mjs --files="巫_20220928_nocom.pdf" --max-images=6 --dry=1   # 抽候选
AB_AI_MODEL=mimo-v2.5 AB_AI_BASE_URL=... AB_AI_API_KEY=... OPENCODE_SESSION=x \
  node scripts/eval/ab-vision-map.mjs --files="巫_20220928_nocom.pdf" --pick="p060_4.jpg,p061_5.jpg"  # 指定图跑 vision
```
