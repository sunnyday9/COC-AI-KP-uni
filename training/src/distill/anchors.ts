/**
 * 锚样本（T4）：mockAi/e2e 剧本格式锚 + 金样本裁定锚。
 *
 * 两个来源，一个共同点——工具行为被确定性期望机械验证，不是教师自由发挥：
 *  1. 金样本锚（主）：#39 golden-samples.json 的情境 + 期望调用序列。教师对
 *     金样本 context 单发重放，产出先过 #39 的 judgeSample（同一裁定器——
 *     格式遵循 + 期望序列命中），**裁定通过者**才并入。即「理想回复该长什么样」
 *     的机器验证版。
 *  2. mockAi/e2e 锚（辅）：mockAi 确定性脚本的关键字回合映射（侦查→skill_check、
 *     战斗→melee 链、恐怖→san_check）落成固定情境种子，走正常 Phase B 重放 +
 *     validate 过滤——叙事与工具行为仍由规则引擎/过滤器把关。
 *
 * mockAi 的「（测试模式）」文案不入数据——锚的是它的回合结构与工具序列形态，
 * 不是它的测试文案。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COC_KP_TOOLS } from '../../../shared/tools/cocTools.js'
import type { COCCharacterSheet } from '../../../shared/types/character.js'
import { callTurn, type EvalEndpoint } from '../../eval/lib/client.js'
import { judgeSample } from '../../eval/lib/judge.js'
import { buildTurnRequest, type KpWireMessage } from '../../eval/lib/request.js'
import { loadSamples } from '../../eval/lib/runner.js'
import type { GoldenSample, ModelResponse } from '../../eval/lib/types.js'
import { buildRagContext } from './corpus.js'
import { toOpenAiToolCall } from './sample.js'
import type { DistillSample } from './types.js'

const EVAL_DIR = fileURLToPath(new URL('../../eval', import.meta.url))

/** 金样本锚：教师单发重放 → #39 裁定 → 通过者成锚（端点异常计入 endpointErrors 不中断）。 */
export async function buildGoldenAnchors(options: {
  ep: EvalEndpoint
  limit?: number
  teacher?: string
  usage: { promptTokens: number; completionTokens: number; calls: number }
}): Promise<{ samples: DistillSample[]; judged: number; rejected: { id: string; category: string; detail: string; usage: { promptTokens: number; completionTokens: number; calls: number } }[]; errors: string[] }> {
  const goldenPath = resolve(EVAL_DIR, 'golden-samples.json')
  const samples: GoldenSample[] = loadSamples(goldenPath)
  const selected = options.limit ? samples.slice(0, options.limit) : samples
  const out: DistillSample[] = []
  const rejected: { id: string; category: string; detail: string; usage: { promptTokens: number; completionTokens: number; calls: number } }[] = []
  const errors: string[] = []

  for (const sample of selected) {
    try {
      const messages: KpWireMessage[] = buildTurnRequest(sample)
      const r = await callTurn(options.ep, messages, COC_KP_TOOLS)
      options.usage.promptTokens += r.usage.promptTokens
      options.usage.completionTokens += r.usage.completionTokens
      options.usage.calls += 1
      const response: ModelResponse = { content: r.content, toolCalls: r.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })) }
      const verdict = judgeSample(sample, response)
      if (verdict.category !== 'pass') {
        rejected.push({
          id: sample.id,
          category: verdict.category,
          detail: verdict.detail,
          usage: { promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, calls: 1 },
        })
        continue
      }
      out.push({
        meta: {
          id: `anchor:golden:${sample.id}`,
          source: 'anchor',
          ...(options.teacher ? { teacher: options.teacher } : {}),
          origin: `golden:${sample.id}`,
          kind: 'turn',
          turnType: 'anchor',
          storyName: sample.storyName,
          turnCount: 1,
          toolCallCount: r.toolCalls.length,
          multiStep: false,
          caveats: [],
          batchPlayers: [],
          usage: { promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, calls: 1 },
        },
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: r.content,
            ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map(toOpenAiToolCall) } : {}),
          },
        ],
        tools: COC_KP_TOOLS,
      })
    } catch (err) {
      errors.push(`金样本锚 ${sample.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { samples: out, judged: selected.length, rejected, errors }
}

/** mockAi/e2e 锚种子（回合结构与批次文案取自 e2e journey 断言与 mockAi 关键字映射）。 */
export interface MockAnchorSeed {
  id: string
  turnType: 'investigate_check' | 'combat_melee' | 'san_encounter'
  storyName: string
  scene: string
  batch: string
  ragContext: string
}

/** 从 demo-story 文本构造 3 条 mockAi/e2e 锚种子（旧图书馆场景——journey 断言同源）。
 *  RAG 串走 buildRagContext（线上 rag 房同形，票 #65）：单块取原文前 700 字，无标题无分节。 */
export function buildMockAnchorSeeds(demoStoryText: string): MockAnchorSeed[] {
  const rag = demoStoryText
    ? buildRagContext([{ storyId: 'anchor:demo', storyName: 'demo', index: 0, content: demoStoryText.slice(0, 700) }])
    : ''
  return [
    {
      id: 'anchor:mock:investigate',
      turnType: 'investigate_check',
      storyName: '旧图书馆的铜钥匙',
      scene: '旧图书馆',
      batch: '【调查员】我仔细侦查房间，搜索书架。',
      ragContext: rag,
    },
    {
      id: 'anchor:mock:combat',
      turnType: 'combat_melee',
      storyName: '旧图书馆的铜钥匙',
      scene: '旧图书馆地下书库',
      batch: '【调查员】扑向潜藏在书架后的黑影，挥拳攻击！',
      ragContext: rag,
    },
    {
      id: 'anchor:mock:san',
      turnType: 'san_encounter',
      storyName: '旧图书馆的铜钥匙',
      scene: '旧图书馆地下书库',
      batch: '【调查员】翻开禁书的一瞬间，我看到了不该看的东西——书页上的文字在蠕动。',
      ragContext: rag,
    },
  ]
}

/** mock/e2e 锚的极简调查员卡（演示情境无卡面；工具上下文需要基础 sheet 形状）。 */
const MOCK_ANCHOR_SHEET: COCCharacterSheet = {
  occupationId: 'archaeologist',
  occupationName: '考古学家',
  playerName: '调查员',
  attributes: { str: 60, con: 60, siz: 55, dex: 65, app: 50, int: 75, pow: 60, edu: 80, luck: 55 },
  skills: { 侦查: 65, 格斗: 55, 图书馆使用: 70, 聆听: 60, 神秘学: 50, 心理学: 60 },
  occupationSkillKeys: ['侦查', '图书馆使用', '神秘学', '心理学', '聆听', '格斗', '信用评级'],
  personalInterestKeys: ['格斗', '聆听', '神秘学', '心理学'],
  derived: { hp: 11, hpMax: 11, mp: 12, mpMax: 12, san: 55, sanMax: 55 },
  weapons: [],
}

/** mock/e2e 锚的固定 skeleton（走正常 Phase B 重放 + validate 过滤）。 */
export function mockAnchorSkeleton(seed: MockAnchorSeed): import('./types.js').DistillSkeleton {
  return {
    id: seed.id,
    source: 'synthetic',
    kind: 'turn',
    turnType: seed.turnType,
    storyName: seed.storyName,
    originId: seed.id,
    batchContent: seed.batch,
    batchPlayers: [seed.batch.match(/^【([^】]*)】/)?.[1] ?? '调查员'],
    characters: { char_0: MOCK_ANCHOR_SHEET },
    activeCharacterId: 'char_0',
    promptInput: { scene: seed.scene, clues: [], history: [], kpMemory: [], longTermSummary: '' },
    ragContext: seed.ragContext,
    caveats: seed.ragContext ? ['rag_lexical_approximation_offline'] : ['rag_context_unavailable_offline'],
  }
}

/** e2e fixture demo-story 路径（锚种子 RAG 素材）。 */
export function loadDemoStoryText(): string {
  const p = fileURLToPath(new URL('../../../e2e/fixtures/demo-story.txt', import.meta.url))
  try {
    return readFileSync(p, 'utf-8').trim()
  } catch {
    return ''
  }
}
