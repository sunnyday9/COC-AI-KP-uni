/**
 * 样本组装（T4）：ReplayedTurn → OpenAI messages+tools JSONL 行。
 *
 * wire 序列 = wireSampleService.buildWireMessages 同形（#37 单源语义）：
 * 初始消息 + 各轮 [assistant(tool_calls OpenAI 形态), tool 回填消息] + 最终叙事
 * assistant（累计 fullContent——线上采样即此形态，蒸馏样本与真实 wire 采样
 * 保持同一训练分布）。
 */
import { COC_KP_TOOLS } from '../../../shared/tools/cocTools.js'
import { buildSlimTurnMessages } from './replay.js'
import type { DistillSample, DistillSkeleton, ReplayedTurn } from './types.js'

function toOpenAiToolCall(t: { id: string; name: string; arguments: string }): {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
} {
  return { id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }
}

/** wire 序列（与 #37 buildWireMessages 同形；最终 assistant = 累计叙事）。 */
export function buildWireSequence(turn: ReplayedTurn): unknown[] {
  const out: unknown[] = buildSlimTurnMessages(turn.skeleton)
  for (const it of turn.iterations) {
    out.push({
      role: 'assistant',
      content: it.assistantContent,
      ...(it.toolCalls.length ? { tool_calls: it.toolCalls.map(toOpenAiToolCall) } : {}),
    })
    for (const tr of it.toolResults) {
      out.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content })
    }
  }
  out.push({ role: 'assistant', content: turn.finalContent })
  return out
}

/** 重放回合 → 训练样本行（调用方保证已通过 filterTurn）。 */
export function buildSample(turn: ReplayedTurn, source: 'seed' | 'synthetic' | 'anchor'): DistillSample {
  const toolCallCount = turn.iterations.reduce((acc, it) => acc + it.toolCalls.length, 0)
  return {
    meta: {
      id: turn.skeleton.id,
      source,
      origin: turn.skeleton.originId,
      kind: turn.skeleton.kind,
      turnType: turn.skeleton.turnType,
      storyName: turn.skeleton.storyName,
      turnCount: turn.iterations.length,
      toolCallCount,
      multiStep: turn.iterations.length >= 2,
      caveats: turn.skeleton.caveats,
      batchPlayers: turn.skeleton.batchPlayers,
      usage: turn.usage,
    },
    messages: buildWireSequence(turn),
    tools: COC_KP_TOOLS,
  }
}

/** 骨架直接可见性（抽检包展示 context 侧时用）。 */
export function skeletonSummary(skeleton: DistillSkeleton): {
  id: string
  turnType: string
  storyName: string
  batchContent: string
  players: string[]
} {
  return {
    id: skeleton.id,
    turnType: skeleton.turnType,
    storyName: skeleton.storyName,
    batchContent: skeleton.batchContent,
    players: skeleton.batchPlayers,
  }
}
