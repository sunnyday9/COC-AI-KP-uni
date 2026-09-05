/**
 * 请求构建（T3 #39）：金样本 → 与线上完全同形的 openai_chat 请求消息。
 *
 * 复用 server 的提示词纯函数（kpPromptService.buildRoomTurnMessages +
 * injectCharacterRoster）保证「同一提示词纯函数产出」；工具循环前轮按
 * kpTurnService 的追加形态回放：assistant(tool_calls OpenAI 形态) +
 * tool(结果回填原文)。唯一的 3 行复制是 toOpenAiToolCallShape（OpenAI wire
 * 形态单点在 server/src/services/wireSampleService.ts，此处不引 server 运行时）。
 */
import { buildRoomTurnMessages, injectCharacterRoster } from '../../../server/src/services/kpPromptService.ts'
import type { GoldenSample } from './types.ts'

/** 线上 KpMessage 的最小 wire 形态（system/user/assistant/tool + tool_calls）。 */
export interface KpWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function toOpenAiToolCallShape(t: { id: string; name: string; arguments: string }) {
  return { id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } }
}

/** 金样本 → 回合请求消息序列（与线上发给 LLM 的序列同构）。 */
export function buildTurnRequest(sample: GoldenSample): KpWireMessage[] {
  const charactersById = sample.charactersById ?? null
  const promptInput = {
    storyName: sample.storyName,
    scene: sample.scene,
    clues: sample.clues,
    messages: sample.history,
    kpMemory: sample.kpMemory,
    longTermSummary: sample.longTermSummary,
    characters: Object.values(charactersById ?? {}),
  }
  let msgs: KpWireMessage[] = buildRoomTurnMessages(promptInput, sample.ragContext ?? '', sample.batchUserContent) as KpWireMessage[]
  msgs = injectCharacterRoster(msgs, charactersById) as KpWireMessage[]
  for (const it of sample.priorIterations ?? []) {
    msgs.push({ role: 'assistant', content: it.assistantContent, tool_calls: it.toolCalls.map(toOpenAiToolCallShape) })
    for (const tr of it.toolResults) {
      msgs.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content })
    }
  }
  return msgs
}
