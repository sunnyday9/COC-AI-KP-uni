/**
 * Phase B——教师重放 KP 回合（T4 核心）：项目提示词 + 瘦身变量块 → 教师按线上
 * 形态回复（叙事 + tool_calls）→ 离线 rule-engine 真实执行工具 → 结果按线上形态
 * 回填 → 续写循环（≤8 轮）→ 完整 wire 序列组装。
 *
 * 与线上 kpTurnService.runKpTurn 逐条对齐：
 *  - 消息组装 = kpPromptService.buildRoomTurnMessages / buildRoomOpeningMessages +
 *    injectCharacterRoster（与 flushTurn 同一条组装路径）；
 *  - 工具执行 = rule-engine processToolCalls + buildToolContext + characterMutators
 *    （真骰子真结算，角色卡跨轮原地变更、按 characterId 分派）；
 *  - 结果回填 = 【结果摘要】头 + 截断 JSON（wireToolMessages = summarize+truncate，
 *    即 LLM 实际看到的 wire——这两个函数在 kpTurnService 内私有且其模块拖 agent/db
 *    运行时栈不可离线 import，按 request.ts「最小复制 + 来源锚定」先例逐字复制）；
 *  - 多角色（D5）：args.characterId 归属校验 + 缺省回退行动者。
 */
import { COC_KP_TOOLS } from '../../../shared/tools/cocTools.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import {
  buildRoomOpeningMessages,
  buildRoomTurnMessages,
  injectCharacterRoster,
} from '../../../server/src/services/kpPromptService.js'
import { processToolCalls } from '../../../server/src/rule-engine/orchestrator.js'
import { buildToolContext } from '../../../server/src/rule-engine/toolContextFactory.js'
import { createCharacterMutatorFactory } from '../../../server/src/rule-engine/characterMutators.js'
import type { TurnCharacterMutators } from '../../../server/src/services/kpTurnService.js'
import { callTurn, type EvalEndpoint } from '../../eval/lib/client.js'
import type { KpWireMessage } from '../../eval/lib/request.js'
import {
  SLIM_CONVERSATION_WINDOW,
  SLIM_SEQ_TOKEN_CAP,
  type DistillSkeleton,
  type ReplayedTurn,
} from './types.js'

const MAX_TOOL_ITERATIONS = 8
/** Cap the tool-result payload echoed back into the conversation（kpTurnService 同值同语义）。 */
const MAX_TOOL_RESULT_CHARS = 600
const MAX_TOOL_RESULT_SUMMARY_CHARS = 120

/* ── 结果回填形态（自 kpTurnService 逐字复制；单源在产品侧，此处仅离线只读复用）───── */

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
}

function summarizeToolResult(content: string): string {
  try {
    const data = JSON.parse(content) as Record<string, unknown>
    if (data === null || typeof data !== 'object') return ''
    const pairs: string[] = []
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      pairs.push(`${k}: ${s.slice(0, 40)}`)
      if (pairs.length >= 6) break
    }
    if (pairs.length === 0) return ''
    let head = `【结果摘要】${pairs.join('；')}`
    if (head.length > MAX_TOOL_RESULT_SUMMARY_CHARS) {
      head = `${head.slice(0, MAX_TOOL_RESULT_SUMMARY_CHARS)}…`
    }
    return head + '\n'
  } catch {
    return ''
  }
}

/* ── 组装与循环 ─────────────────────────────────────────────── */

/** 粗估 token（中文为主 ≈ 1 token/1.6 chars）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.6)
}

/** 序列 cap（~6k）：超限时先丢最旧对话消息（system/RAG/本批不动）。 */
export function pruneForSeqCap(messages: KpWireMessage[]): KpWireMessage[] {
  const totalTokens = () => messages.reduce((acc, m) => acc + estimateTokens(m.content), 0)
  const out = messages.slice()
  const firstConversation = 1 // [0] = system
  while (totalTokens() > SLIM_SEQ_TOKEN_CAP && out.length > firstConversation + 1) {
    out.splice(firstConversation, 1)
  }
  return out
}

/** 骨架 → 瘦身后的回合请求消息（system+近窗(≤8)+本批 + 花名册）。 */
export function buildSlimTurnMessages(skeleton: DistillSkeleton): KpWireMessage[] {
  const input = {
    storyName: skeleton.storyName,
    scene: skeleton.promptInput.scene,
    clues: skeleton.promptInput.clues,
    messages: skeleton.promptInput.history.slice(-SLIM_CONVERSATION_WINDOW),
    kpMemory: skeleton.promptInput.kpMemory,
    longTermSummary: skeleton.promptInput.longTermSummary,
    characters: Object.values(skeleton.characters),
  }
  const base: KpWireMessage[] =
    skeleton.kind === 'opening'
      ? buildRoomOpeningMessages(input, skeleton.ragContext)
      : buildRoomTurnMessages(input, skeleton.ragContext, skeleton.batchContent)
  return pruneForSeqCap(injectCharacterRoster(base, skeleton.characters) as KpWireMessage[])
}

function makeMutatorFactory(characters: Record<string, COCCharacterSheet>, activeCharacterId: string | null, worldDeltas: {
  cluesAdded: { description: string; clueId?: string }[]
  sceneChanged?: string
  ending?: { outcome: string; title: string; summary: string }
}) {
  return createCharacterMutatorFactory({
    resolveSheet: (id) => (id && characters[id] ? characters[id] : (activeCharacterId ? characters[activeCharacterId] : null)) ?? null,
    transitionToScene: (sceneName) => {
      worldDeltas.sceneChanged = sceneName
    },
    addClue: (description, clueId) => {
      worldDeltas.cluesAdded.push({ description, clueId })
    },
    endGame: (ending) => {
      worldDeltas.ending = { outcome: ending.outcome, title: ending.title, summary: ending.summary }
    },
  })
}

/** 重放一个骨架：教师循环 + rule-engine 执行 + wire 组装。任何端点异常向上抛（调用方记账）。 */
export async function replaySkeleton(ep: EvalEndpoint, skeleton: DistillSkeleton): Promise<ReplayedTurn> {
  const characters = skeleton.characters
  const allowedCharacterIds = new Set(Object.keys(characters))
  const worldDeltas: {
    cluesAdded: { description: string; clueId?: string }[]
    sceneChanged?: string
    ending?: { outcome: string; title: string; summary: string }
  } = { cluesAdded: [] }
  const mutatorFactory = makeMutatorFactory(characters, skeleton.activeCharacterId, worldDeltas)

  let msgs: KpWireMessage[] = buildSlimTurnMessages(skeleton)
  const iterations: ReplayedTurn['iterations'] = []
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 }
  const fullParts: string[] = []
  let hitCap = false

  let idCounter = 0
  const generateId = (): string => `distill_${Date.now()}_${idCounter++}`

  for (let loop = 0; loop < MAX_TOOL_ITERATIONS; loop++) {
    const r = await callTurn(ep, msgs, COC_KP_TOOLS)
    usage.promptTokens += r.usage.promptTokens
    usage.completionTokens += r.usage.completionTokens
    usage.calls += 1
    const iterContent = r.content || ''
    if (iterContent.trim()) fullParts.push(iterContent.trim())
    if (r.toolCalls.length === 0) break

    const executed: { role: 'tool'; tool_call_id: string; content: string }[] = []
    for (const tc of r.toolCalls) {
      // D5 归属校验：args.characterId 必须在小队内，否则回退行动者（与线上同语义）
      let targetId = skeleton.activeCharacterId
      try {
        const args = JSON.parse(tc.arguments || '{}') as { characterId?: unknown }
        if (typeof args.characterId === 'string' && characters[args.characterId]) {
          if (allowedCharacterIds.has(args.characterId)) targetId = args.characterId
        }
      } catch {
        /* 参数解析失败 → 行动者（filter 侧另判 bad_args） */
      }
      const m: TurnCharacterMutators = mutatorFactory(targetId)
      const ctx = buildToolContext({
        characterSheet: targetId ? characters[targetId] ?? null : null,
        ...m,
        generateId,
      })
      const { toolResults } = processToolCalls(
        [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
        ctx,
      )
      executed.push(...toolResults)
    }

    const wireToolMessages = executed.map((tr) => ({
      ...tr,
      content: summarizeToolResult(tr.content) + truncateToolResult(tr.content),
    }))
    iterations.push({
      assistantContent: iterContent,
      toolCalls: r.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })),
      toolResults: wireToolMessages,
    })
    msgs = [
      ...msgs,
      {
        role: 'assistant',
        content: iterContent,
        tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })),
      },
      ...wireToolMessages,
    ]
    if (loop === MAX_TOOL_ITERATIONS - 1) hitCap = true
  }

  return {
    skeleton,
    iterations,
    finalContent: fullParts.join('\n\n'),
    usage,
    worldDeltas,
    hitCap,
  }
}
