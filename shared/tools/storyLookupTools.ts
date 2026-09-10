/**
 * Story-lookup tools for the dossier workflow (experiment branch
 * feature/kp-dossier-workflow). These are read-only verification tools the KP
 * can call when it needs story facts beyond the static 当前场景档案 block.
 *
 * Deliberately NOT part of COC_KP_TOOLS: they are only meaningful for dossier
 * rooms and are appended to the tool list at invocation time (kpTurnService
 * injects them via the dossier query fn). Keeping them out of the base list
 * avoids breaking rule-engine tool consistency checks and the protocol-level
 * tool-count tests for the rag workflow.
 *
 * Wire shape mirrors KpToolDef ({ type:'function', function:{ name, … } }).
 */
export interface StoryLookupToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string; enum?: string[] }>
      required: string[]
    }
  }
}

/** List all scenes in the story's dossier (names + one-line descriptions). */
export const SCENE_LIST_TOOL: StoryLookupToolDef = {
  type: 'function',
  function: {
    name: 'scene_list',
    description:
      '列出剧本档案中的全部场景/地点（名称 + 一句话简介）。当你需要确认故事里有哪些可前往的地点、或判断调查员提到的某个地方是否存在于剧本中时调用。只读，无副作用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

/** Fetch the full dossier block of one scene (narrative text, NPCs, clues). */
export const SCENE_DOSSIER_TOOL: StoryLookupToolDef = {
  type: 'function',
  function: {
    name: 'scene_dossier',
    description:
      '按场景名取回该场景的完整档案：现场描述原文、在场 NPC、可获得线索、可推进的行动。当调查员进入新场景或你需要该场景的精确细节（场景原文、NPC 名字/身份、该处可获得的线索）时调用。只读，无副作用。',
    parameters: {
      type: 'object',
      properties: {
        sceneName: { type: 'string', description: '场景名称（来自 scene_list 或剧本原文，如"旧图书馆"）' },
      },
      required: ['sceneName'],
    },
  },
}

/** Lexical keyword search across the dossier (scenes/clues/NPCs). */
export const LEXICAL_SEARCH_TOOL: StoryLookupToolDef = {
  type: 'function',
  function: {
    name: 'lexical_search',
    description:
      '在剧本档案中按关键词检索（词面匹配场景/线索/NPC）。当你想确认某个名词（人名、物件、地名、线索关键词）是否在剧本中出现、或不确定信息属于哪个场景时调用。只读，无副作用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的关键词（中文名词，如"钥匙""阿洛伊斯""地下室"）' },
      },
      required: ['query'],
    },
  },
}

/** Verify a specific fact against the raw story text (fresh-context sub-reader). */
export const VERIFY_ORIGINAL_TOOL: StoryLookupToolDef = {
  type: 'function',
  function: {
    name: 'verify_original',
    description:
      '在剧本原文中查证一个具体事实：服务端取与当前场景/问题相关的原文片段，交给一个只看原文的子阅读器作答，返回结论 + 逐字原文引用。' +
      '当档案里没有、说不清，或你需要原文级精确细节（原文措辞、数字、原名、NPC 原话）时调用。' +
      '返回「未取得」表示原文片段里也没有该信息——此时必须如实叙事或让调查员以行动获取，不要编造。' +
      '剧透约定：结论带「剧透层·仅限 KP 内部裁定」时，只能用它决定现在能否给线索/如何引导，禁止向玩家复述其内容。只读，无副作用。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要查证的具体问题（一句话，如"钟楼地下室的门是什么状态？"、"海哥的本名是什么？"）',
        },
        scene: {
          type: 'string',
          description: '可选：限定在某个场景的原文范围内查证（场景名，来自 scene_list）。缺省 = 当前场景；跨场景/全篇问题时留空。',
        },
      },
      required: ['question'],
    },
  },
}

/** All story-lookup tool defs (appended for dossier rooms). */
export const STORY_LOOKUP_TOOLS: StoryLookupToolDef[] = [
  SCENE_LIST_TOOL,
  SCENE_DOSSIER_TOOL,
  LEXICAL_SEARCH_TOOL,
  VERIFY_ORIGINAL_TOOL,
]

export const STORY_LOOKUP_TOOL_NAMES: string[] = STORY_LOOKUP_TOOLS.map((t) => t.function.name)
