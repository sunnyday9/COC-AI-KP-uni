# training — KP 自训模型数据/训练/评测工作区

独立工作区（ADR-0006「后果」第 1 条）：训练/数据/评测脚本不进 server 运行时依赖树；
server 不依赖本目录。本工作区只依赖 Node ≥24 标准库 + vitest/tsx/typescript，
跨工作区**只 import 服务端提示词纯函数与 shared 常量**（kpPromptService / cocTools），
不 import 任何带运行时副作用的 server 模块（db/config/agent 栈）。

## 票链（spec #36）

| 票 | 内容 | 位置 |
| --- | --- | --- |
| #37 T1 ✅ | wire 采样日志 | server（唯一新缝） |
| #38 T2 | **数据导出器（本目录 `src/exporter.ts`）** | training |
| #39 T3 | 金样本评测集 + 评测 harness | training（`eval/`） |
| #40 T4 | 蒸馏数据生成（教师重放 → validate 过滤） | training |
| #41 T5 | Kaggle 训练管线（LLaMA-Factory QLoRA） | training |
| #42/#43 T6/T7 | 三层评测 gate / gate 判定 | training |

## 数据导出器（#38）

从既有对局快照与存档导出「上下文 + 玩家行动流」骨架——每行 = 一个 KP 回合的
context 侧 + 线上 24 工具定义，即 **OpenAI messages + tools JSONL**（Hermes 风格，
LLaMA-Factory 原生直吃）。#40 教师模型在此骨架上重放理想回复（响应侧）。

```bash
# 全量导出（默认读 server/data/ai-kp.db，写 training/out/kp-context.jsonl）
npm run export:kp-context -- --out kp-context.jsonl

# 过滤 + 自定义路径
npm run export:kp-context -- --out runs/demo.jsonl --room room_xxx --save save_yyy

# 数据不在仓库内时声明 IO 根（路径越界一律拒绝）
KP_EXPORT_DB_ROOT=/data/prod KP_EXPORT_OUT_ROOT=/data/out npm run export:kp-context -- --out a.jsonl --db ai-kp.db
```

### 输出行契约

```jsonc
{
  "meta": {
    "kind": "opening | turn",          // 开场回合 / 玩家行动回合
    "source": "wire | rebuilt",        // 真实注入逐字拷贝 / 提示词纯函数确定性重建
    "origin": "room | orphan-wire | save", // 在场房间 / 已回收房间的采样 / 旧版存档
    "roomId": "…", "saveId": null, "userId": 7, "storyId": "…", "storyName": "…",
    "turnSeq": 12,                     // wire 行的采样序号（#40 回链全量采样用）；rebuilt 为 null
    "turnIndex": 3,                    // 游戏流内回合序（opening 计入）
    "batchPlayerMessages": 2,          // 本批合并的玩家行动条数
    "ragContextChars": 512,            // 实际进入 system 的 RAG 注入字符数
    "caveats": [                       // 离线重建限制（wire 行恒空）
      "rag_context_unavailable_offline",     // RAG 检索依赖在线 embedding，重建行无故事情报
      "state_blocks_from_final_snapshot"     // 记忆/线索/场景取自终局快照（开场行除外）
    ]
  },
  "messages": [ { "role": "system", "content": "…" }, …, { "role": "user", "content": "【玩家A】行动\n【玩家B】行动" } ],
  "tools": [ /* shared/tools/cocTools.ts COC_KP_TOOLS 逐字 */ ]
}
```

- **wire 优先**（票 #38 验收 3）：回合在 `kp_wire_samples` 有采样时，context =
  落库 `initialMessages` 的逐字前缀（首个 assistant 消息之前）——线上当刻的真实注入。
  wire 行不含响应侧；需要真实响应/工具链时按 `roomId+turnSeq` 回链采样行全量数据。
- **确定性重建**：无采样的回合（历史局/存档/未采样回合）用与
  `roomService.flushTurn → runKpTurn` 同一条纯函数路径重建
  （`buildRoomTurnMessages` / `buildRoomOpeningMessages` / `injectCharacterRoster`），
  保证与线上请求形态同构（票 #38 验收 2）。
- **来源标注**：`meta.source/origin/caveats` 三层标注；孤儿采样（房间被 TTL 回收、
  rooms 行已删）独立成行——房间短暂、采样长存，这是长期数据积累的主路径。
- **开局识别**：`kind=opening` 的行以固定开场请求收尾（`OPENING_USER_REQUEST`）；
  重建的开场行在空状态上组装（与线上 opening 语义一致）。
- 历史消息格式与线上一致：近窗对话内 `[玩家名] 内容`，收尾批量行动 `【玩家名】 内容`。
- wire 匹配算法：批量内容双指针顺序配对（采样序是回合序的子序列）；已知近似——
  同一局内两个完全相同文案的批量且前者无采样时会错配（见 exporter.ts 存证注释）。

## 测试

```bash
npm run test:training   # 根目录脚本（CI 步骤同款）
```

- 金样本 fixture：`test/fixtureDb.ts` 以 e2e demo 剧本《旧图书馆的铜钥匙》为蓝本
  构建确定性 sqlite 库（房间 wire×2 / 无采样回合 / 孤儿采样 / 旧版存档）；
- 输出快照：`fixtures/gold-demo-export.json`（meta + messages + toolNames 投影；
  tools 全量由独立断言与 `COC_KP_TOOLS` 深等）；
- 同构对拍：重建行直接与 `buildRoomTurnMessages + injectCharacterRoster` 输出深等。
