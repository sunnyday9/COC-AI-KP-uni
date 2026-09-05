/** 金样本评测（T3 #39）共享类型。 */
import type { COCCharacterSheet } from '../../../shared/types/character.js'

/**
 * 形态对齐线上回合请求（kpTurnService.runKpTurn 的工具循环）：
 *   请求 = buildRoomTurnMessages(system+近窗+RAG+状态) + 花名册注入
 *        + priorIterations 的 [assistant(tool_calls) + tool(结果回填)]
 *   响应 = { content, tool_calls } —— 与 openai_chat 适配器产出同形。
 */

/** 一条金样本。expect.alternatives 任一命中即裁定正确；noTools 样本要求零工具调用。 */
export interface GoldenSample {
  id: string
  /** 主工具名或 'narrative' / 'multi' / 'continuation'（覆盖度统计用）。 */
  category: string
  /** 该样本覆盖的工具（含链路后续），用于「24 工具主组合覆盖」校验。 */
  tools: string[]
  /** 人工复核注记：期望参数的规则依据（哪些是规则强制、哪些是剧本给定）。 */
  notes: string
  /** 剧本故事名（进 system 的「## 故事」）。 */
  storyName: string
  /** 当前场景（可为 null）。 */
  scene: string | null
  /** 已获线索（进 system 状态块）。 */
  clues: { id: string; description: string }[]
  /** 近窗历史（kp/player 交替；与线上 Message 同形的最小结构）。 */
  history: { role: 'kp' | 'player'; playerName?: string; content: string }[]
  /** KP 记忆条目（进 system 记忆块）。 */
  kpMemory: string[]
  /** 长期记忆摘要（可为空串）。 */
  longTermSummary: string
  /** 当轮 RAG 注入原文（空串 = 无注入）。 */
  ragContext: string
  /** 行动者/在场调查员（characters.json 的角色卡 id，按房间花名册顺序；单人一个）。 */
  characters?: string[]
  /** 加载器按 characters[] 解析填充（样本文件里不重复卡片本体）。 */
  charactersById?: Record<string, COCCharacterSheet>
  /** 本批合并玩家行动（线上 flushTurn 形态：`【用户名】内容` 逐行）。 */
  batchUserContent: string
  /** 工具循环前轮（续接样本）：assistant tool_calls + 线上同形态工具结果回填。 */
  priorIterations?: {
    assistantContent: string
    toolCalls: { id: string; name: string; arguments: string }[]
    toolResults: { tool_call_id: string; content: string }[]
  }[]
  expect: {
    /** 纯叙事样本：要求零工具调用。 */
    noTools?: boolean
    /** 可接受的工具调用序列（有序，按序子列匹配）；args 为必须精确匹配的参数子集。 */
    alternatives: ExpectedCall[][]
  }
}

/** 期望的一次工具调用：name 必须相等；args 子集匹配；forbid 中的键值对不得出现。 */
export interface ExpectedCall {
  name: string
  args?: Record<string, unknown>
  forbid?: Record<string, unknown>
}

/** 判定后的单样本结果。 */
export interface SampleJudgement {
  id: string
  formatOk: boolean
  verdictOk: boolean
  /** 失败主分类（ticket #39 四类 + 解析失败）：pass/unparseable/text_dice/no_tool_call/wrong_tool/bad_args。 */
  category: 'pass' | 'unparseable' | 'text_dice' | 'no_tool_call' | 'wrong_tool' | 'bad_args'
  detail: string
}

/** 归一化后的模型响应（openai_chat message 的最小形态）。 */
export interface ModelResponse {
  content: string
  toolCalls: { name: string; arguments: string }[]
}
