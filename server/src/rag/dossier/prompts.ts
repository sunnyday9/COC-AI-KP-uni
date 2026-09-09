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
    '  "scenes": [{ "id": "唯一id(如scene_1)", "name": "场景/地点名", "sceneText": "本段中该场景的原文叙事(可多句，保留氛围细节)", "description": "一句话场景简介", "npcIds": ["出现在该场景的npc的id或名字"], "clueIds": ["该场景可获得的线索id或描述"], "requiredClues": ["解锁该场景前必须先获得线索的id或描述(可省略)"], "hooks": ["调查员进入该场景时可用的行动引导(2-3条)"] }],',
    '  "clues": [{ "id": "唯一id(如clue_1)", "description": "线索内容描述(调查员获得它时应知道什么)", "location": "在哪个场景/何处找到", "requiredClues": ["获得此线索前需先有的线索id或描述(可省略)"], "obtainCondition": "自然语言描述如何获得(可省略)" }],',
    '  "npcs": [{ "id": "唯一id(如npc_1)", "name": "名字", "role": "身份/职业", "description": "外貌与性格概述", "details": "该npc的关键背景/台词/秘密(原文相关)", "relations": [{ "target": "有关系的对方npc的id或名字", "type": "关系类型：亲属/同事/师生/恋人/敌对/仇人/秘密关联/上下级/其他", "note": "一句话说明(可省略)" }] }],',
    '  "transitions": [{ "id": "唯一id(如tr_1)", "from": "起点场景的id或名字", "to": "可达场景的id或名字", "condition": "何时/怎样可走这条边(自然语言；无门槛可省略)", "viaClues": ["解锁这条边所需线索的id或描述(可省略)"] }],',
    '  "events": [{ "id": "唯一id(如ev_1)", "when": "剧本内时间表述(如\\"2月16日夜\\"/\\"开场前十年\\"；无明确时间可省略)", "summary": "发生了什么事(1-2句)", "scene": "发生地场景id或名字(可省略)", "npcs": ["涉及人物id或名字(可省略)"], "critical": true }],',
    '  "truths": [{ "id": "唯一id(如truth_1)", "title": "真相短标题(如\\"逐日工程引来星之彩\\")", "detail": "真相完整描述(2-4句：幕后黑手/事件起因经过结果)", "relatedClues": ["支撑该真相的线索id或描述(可省略)"], "revealScene": "玩家主要揭晓该真相的场景id或名字(可省略)" }],',
    '  "endings": [{ "id": "唯一id(如end_1)", "name": "结局名(如\\"好结局：星之彩被遣返\\")", "condition": "达成该结局的条件(自然语言，可引用线索/行动/时间)", "outcome": "结局发生后的事(玩家所见/世界变化，可省略)", "relatedTruths": ["关联真相id或标题(可省略)"] }],',
    '  "meta": { "title": "模组名(第一段填，后段可省略)", "timeframe": "故事发生的时代/时间背景", "premise": "开场钩子/委托由头(一句话，不剧透结局)", "background": "世界观/背景设定(不剧透结局真相，供理解世界)" }',
    '}',
    '',
    '规则：',
    '- 场景(scene)通常是一个可移动到的地点/场所；同一个地点被多次描写时合并成一个场景并把 sceneText 拼接。',
    '- **sceneText 是原文誊抄而非概括**：直接抄录本段中该场景的叙事文字（可多段拼接，保留氛围细节），不要在 sceneText 里加"调查员看到/这时……"这类转述衔接；衔接句最多一两句极短。宁可多抄，不要压缩成梗概。',
    '- 线索(clue)是调查员可以发现的具体信息/物件；开锁/解锁关系的场景(如"地下室需要钥匙")应通过 requiredClues 或 transitions 表达。',
    '- 不要把背景介绍或结局说明硬拆成场景；世界观/背景放 meta.background。',
    '- transitions 描述场景之间的可达关系：本段出现"从X到Y"或"去往Y"即可记一条边；后续批可能补充新边，尽量每条边独立成条（同一条边不要重复）。',
    '- events 是剧本时间线上的事件（失踪、失窃、集会、冲突等），按**剧情时间先后**输出；倒叙/插叙的内容按其实际发生时间放。',
    '- npc 的 relations 只记剧情关键关系；同一对关系不要重复。',
    '- truths 只收真正的幕后真相/大秘密（真凶、事件本质、关键身世）；endings 收剧本明确写出的结局及达成条件（好/坏/普通都收）。**真相与结局是剧透内容，但它们仍会出现在对应场景的 sceneText 原文里——结构化到 truths/endings 后不得从场景文本中删除原文。** 本节没出现真相/结局时输出空数组。',
    '- **truth 正确性（P24）**：truth 描述必须与本节 npc/events/sceneText 交叉一致（同一真相在不同条目中不得互相矛盾；写清谁做的/为什么/结果如何）；**禁止把表象当作真相本体**（如"学校宣称是传染病"只是表象，真相要落到事件背后的真实因果，如"逐日工程引来的星之彩"）。revealScene 只能取 scenes.name 原文（本节或此前清单），**不得用"后续场景可能揭晓"这类占位**；relatedClues 只能取 clues.description 原文；找不到对应实体就不写该字段（宁可省略不得编造）。endings.condition 只写剧本原文明确给出的行动/条件与时间节点，不要自创解法；relatedTruths 用真相 title 原文。',
    '- **引用规范**：跨段引用一律用**名字**，且必须与本节出现的条目或【此前已识别清单】逐字一致（transitions/relations/events/truths/endings 引用场景/人物/线索用其 name/description 原文，不要用变体、简称或临时起的新称呼）。',
    '- 一个人物有多个称呼（本名/化名/外号）时只建一个 npc 条目：name 用最常用称呼，其余称呼写进该 npc 的 details（注明"又名"）。',
    '- 引用点在本节与清单中都找不到对应实体时，**不要编造端点**：宁可省略该条引用，也不得出现指向不存在实体的边。',
    '- 本段没有任何可整理内容时输出 {"scenes": [], "clues": [], "npcs": [], "transitions": [], "events": [], "truths": [], "endings": []}。',
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
    transitions: [],
    events: [],
    truths: [],
    endings: [],
    meta: parts.find((p) => p.meta)?.meta,
  }
  const seenScene = new Set<string>()
  const seenClue = new Set<string>()
  const seenNpc = new Set<string>()
  const seenTransition = new Set<string>()
  const seenEvent = new Set<string>()
  const seenTruth = new Set<string>()
  const seenEnding = new Set<string>()
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
        continue
      }
      // 后批补充已见 npc：合并 details 空缺与新增关系（不丢跨批关系边）
      const existing = out.npcs.find((x) => x.name === n.name)
      if (existing) {
        if (!existing.details && n.details) existing.details = n.details
        if (n.relations?.length) {
          existing.relations = existing.relations ?? []
          const seenRel = new Set(existing.relations.map((r) => `${r.target}|${r.type}`))
          for (const r of n.relations) {
            const key = `${r.target}|${r.type}`
            if (!seenRel.has(key)) {
              seenRel.add(key)
              existing.relations.push(r)
            }
          }
        }
      }
    }
    for (const t of part.transitions || []) {
      const key = `${t.from}|${t.to}`
      if (!seenTransition.has(key)) {
        seenTransition.add(key)
        out.transitions!.push(t)
      }
    }
    for (const e of part.events || []) {
      const key = `${e.when ?? ''}|${e.summary}`
      if (!seenEvent.has(key)) {
        seenEvent.add(key)
        out.events!.push(e)
      }
    }
    for (const t of part.truths || []) {
      if (!seenTruth.has(t.title)) {
        seenTruth.add(t.title)
        out.truths!.push(t)
      }
    }
    for (const en of part.endings || []) {
      if (!seenEnding.has(en.name)) {
        seenEnding.add(en.name)
        out.endings!.push(en)
      }
    }
  }
  if (!out.transitions?.length) delete out.transitions
  if (!out.events?.length) delete out.events
  if (!out.truths?.length) delete out.truths
  if (!out.endings?.length) delete out.endings
  return out
}
