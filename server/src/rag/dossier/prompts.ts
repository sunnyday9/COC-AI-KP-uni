/**
 * Dossier generation prompt — asks the LLM to structure an arbitrary story
 * (PDF/txt/md…) into scenes / clues / NPCs with machine-readable gates.
 *
 * Output contract: a SINGLE JSON object with arrays `scenes`, `clues`, `npcs`
 * (see schema.ts StoryDossier). The extraction is batched per story section so
 * a large PDF (up to ~170k chars) stays within per-call input budgets; later
 * batches pass the already-seen entity names to stay consistent.
 */
import type { StoryDossier } from './schema.js'

export const DOSSIER_SYSTEM_PROMPT =
  '你是跑团模组的结构整理器。把用户提供的剧本内容整理成结构化 JSON 供 AI 守密人（KP）使用。' +
  '只输出一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码块围栏。'

/** Text passed to the generator when a batch is too big for one call. */
export interface DossierBatchInput {
  batchIndex: number
  /** Raw story text for this batch. */
  storyText: string
  /** Entity names already extracted by earlier batches (for consistency). */
  seenSceneNames: string[]
  seenNpcNames: string[]
  seenClueDescriptions: string[]
}

export const DOSSIER_MAX_CHARS_PER_CALL = 12_000

/** How much raw story text the generator sees per batch (characters). */
export const DOSSIER_BATCH_CHARS = 10_000

export function buildDossierPrompt(input: DossierBatchInput): string {
  const seenParts: string[] = []
  if (input.seenSceneNames.length) seenParts.push(`本故事中此前已识别出的场景名：${input.seenSceneNames.join('、')}`)
  if (input.seenNpcNames.length) seenParts.push(`此前已识别出的 NPC/人物名：${input.seenNpcNames.join('、')}`)
  if (input.seenClueDescriptions.length) seenParts.push(`此前已识别出的线索（避免重复）：${input.seenClueDescriptions.join('；')}`)

  return [
    '请把下面这段剧本内容整理成 JSON。若本段与故事其他部分同属一个完整模组，只整理本段涉及的信息。',
    '',
    'JSON 结构：',
    '{',
    '  "scenes": [{ "id": "唯一id(如scene_1)", "name": "场景/地点名", "sceneText": "本段中该场景的原文叙事(可多句，保留氛围细节)", "description": "一句话场景简介", "npcIds": ["出现在该场景的npc的id"], "clueIds": ["该场景可获得的线索id"], "requiredClues": ["解锁该场景前必须先获得线索的id(可省略)"], "hooks": ["调查员进入该场景时可用的行动引导(2-3条)"] }],',
    '  "clues": [{ "id": "唯一id(如clue_1)", "description": "线索内容描述(调查员获得它时应知道什么)", "location": "在哪个场景/何处找到", "requiredClues": ["获得此线索前需先有的线索id(可省略)"], "obtainCondition": "自然语言描述如何获得(可省略)" }],',
    '  "npcs": [{ "id": "唯一id(如npc_1)", "name": "名字", "role": "身份/职业", "description": "外貌与性格概述", "details": "该npc的关键背景/台词/秘密(原文相关)" }]',
    '}',
    '',
    '规则：',
    '- 场景(scene)通常是一个可移动到的地点/场所；同一个地点被多次描写时合并成一个场景并把 sceneText 拼接。',
    '- 线索(clue)是调查员可以发现的具体信息/物件；开锁/解锁关系的场景(如"地下室需要钥匙")应通过 requiredClues 表达。',
    '- 不要把背景介绍或结局说明硬拆成场景；结局信息可放在最后一个场景的 sceneText 或 description 里。',
    '- id 用英文小写+下划线。name/description 用中文。只输出 JSON，不要代码块围栏。',
    ...(seenParts.length ? ['', ...seenParts] : []),
    '',
    '=== 剧本内容（本节）===',
    input.storyText,
  ].join('\n')
}

/** Merge partial batch parses into one dossier (later batches win on conflicts). */
export function mergeDossierParts(parts: StoryDossier[]): StoryDossier {
  const out: StoryDossier = {
    scriptId: parts.find((p) => p.scriptId)?.scriptId ?? '',
    storyName: parts.find((p) => p.storyName)?.storyName ?? '',
    generatedAt: parts[0]?.generatedAt ?? Date.now(),
    generatedByModel: parts.find((p) => p.generatedByModel)?.generatedByModel,
    scenes: [],
    clues: [],
    npcs: [],
  }
  const seenScene = new Set<string>()
  const seenClue = new Set<string>()
  const seenNpc = new Set<string>()
  for (const part of parts) {
    for (const s of part.scenes || []) {
      if (!seenScene.has(s.name)) {
        seenScene.add(s.name)
        out.scenes.push(s)
      }
    }
    for (const c of part.clues || []) {
      if (!seenClue.has(c.description)) {
        seenClue.add(c.description)
        out.clues.push(c)
      }
    }
    for (const n of part.npcs || []) {
      if (!seenNpc.has(n.name)) {
        seenNpc.add(n.name)
        out.npcs.push(n)
      }
    }
  }
  return out
}
