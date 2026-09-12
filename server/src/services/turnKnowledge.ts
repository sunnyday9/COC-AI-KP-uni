/**
 * TurnKnowledge — 回合知识装配的 deep module（「KP 本回合看到什么知识」的唯一 interface）。
 *
 * 收编自 RoomService 的回合知识装配私有方法（fetchKnowledge / fetchRagContext /
 * fetchDossierContext / fetchTurnSupplement / prefetchVerification / fetchStoryName）
 * 与两份 trace JSONL helper——此前 flushTurn 与 opening 两条回合入口各装配一遍、
 * 「同口径」的注入列拼装在两处重复。本模块**无状态**：RoomService 的运行时状态
 * （房间 id / owner / 剧本 / 场景 / 玩家发言）以参数传入；不持有实例、不 import
 * roomStorage、不读房间表。
 *
 * 唯一实现处（对外只有 assembleTurnKnowledge / buildStoryLookup 两个入口）：
 *  - workflow 分派：rag = 玩家发言当 query 的标准检索情报块（plain 模式，ADR-0007 决策 2）；
 *    dossier = 当前场景档案块（含「未覆盖」分支）+ 检索补充层（supplement 模式，ADR-0007 决策 5）
 *  - P27 预取触发（事实层深挖；仅玩家回合——opening 无玩家问句，不触发）
 *  - PREFETCH_TRACE / SUPPLEMENT_TRACE 逐行 JSONL 落盘（实验追踪，默认关；两份
 *    曾复制的 helper 在此归一）
 *  - wire 采样「注入列」拼装：`[sceneBlock, supplement].filter(nonEmpty).join('\n\n') || ragContext`
 *    ——该口径**只存在于此**（ab-compare 报告按此格式统计注入量与还原现场）
 *
 * 对知识层实现（dossierCore / coverageGaps / supplementService / supplementAssembly /
 * prefetch / originalLookup / ragService / settingsService）保持动态 import（Mimosa
 * 门禁安全边界：轻消费方不背重依赖链，RoomService → 本模块同样走动态 import）。
 * 任何失败一律静默降级为空串/空块——回合不因知识装配中断（既有约定）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { OPENING_RAG_QUERY, type StoryWorkflow } from './kpPromptService.js'
import type { SceneCoverage } from '../rag/dossier/coverageGaps.js'

/** 回合阶段：玩家回合（flushTurn） vs 开场回合（opening）。两条路径的知识差异全在此：
 *  rag 检索 query（玩家合并发言 vs OPENING_RAG_QUERY）、补充层 query（玩家合并发言
 *  vs ''——T4 契约：无玩家文本退化为纯场景名）、预取（触发 vs 不触发）。 */
export type TurnStage = 'turn' | 'opening'

/** 装配输入：RoomService 运行态的一次性快照（装配时刻读取，与原两处装配同时刻）。 */
export interface TurnKnowledgeInput {
  /** 房间知识 workflow：rag = 检索情报块；dossier = 档案场景块 + 补充层。 */
  workflow: StoryWorkflow
  /** KP/RAG/记忆全程跟随现任 owner（ADR-0005）：剧本/档案/嵌入按它解析。 */
  ownerId: number
  /** 剧本 id（null = 未绑定剧本 → 全部落空降级为空）。 */
  storyId: string | null
  /** 房间 id（trace JSONL / KP_LLM_DEBUG 日志标识）。 */
  roomId: string
  /** 房间当前场景（null = 新局还没切过场景；有值但对不上档案 → renderSceneUncovered 分支）。 */
  scene: string | null
  /** 玩家合并发言（含【玩家名】前缀；rag 检索 / 补充层 / 预取共用）。opening 传 ''。 */
  playerText: string
  stage: TurnStage
}

/** 装配产物：提示词知识块（buildRoomTurn/OpeningMessages 的直通参数）+ 采样注入列。 */
export interface TurnKnowledge {
  /** rag 房检索情报块（dossier 房恒 ''——其事实权威是场景块）。 */
  ragContext: string
  /** dossier 当前场景档案块（含「未覆盖」提示分支；'' = 无）。 */
  sceneBlock: string
  /** P27 预取查证结论（仅玩家回合触发；'' = 未触发 / 未取得 / 失败降级）。 */
  verifyBlock: string
  /** 检索补充小节（已渲染文本；'' = 不注入——开关关闭或本轮无命中）。 */
  supplement: string
  /** 归一后的场景名（档案匹配口径；错配时 = 房间场景名，回落时 = 首场景名）。 */
  sceneName?: string
  /** 当前场景覆盖度（P27 预取判定复用；unmatched 时 null 且不读 gaps）。 */
  coverage?: SceneCoverage | null
  /** 剧本名（提示词「## 故事:」行；失败回退 ''）。 */
  storyName: string
  /** wire 采样「注入列」——拼装口径全仓唯一（见模块头注释）。 */
  wireInjectionText: string
}

/** 实验追踪（PREFETCH_TRACE / SUPPLEMENT_TRACE=<path>，默认关）：逐行 JSONL，
 *  供报告统计触发/命中。字段顺序 { at, roomId, storyId, ...e }（两份旧 helper 的并集形态）。 */
function appendTraceFile(envName: string, roomId: string, storyId: string | null, event: Record<string, unknown>): void {
  const trace = process.env[envName]
  if (!trace) return
  try {
    mkdirSync(dirname(trace), { recursive: true })
    appendFileSync(trace, JSON.stringify({ at: Date.now(), roomId, storyId, ...event }) + '\n')
  } catch {
    /* 追踪失败不影响回合 */
  }
}

/**
 * 回合知识装配唯一入口：两条回合路径（flushTurn / opening）各一行调用。
 * 内部次序与原两处装配逐一同构：知识块与剧本名并行 → 预取与补充层并行
 * （opening 不触发预取）→ 注入列拼装。
 */
export async function assembleTurnKnowledge(input: TurnKnowledgeInput): Promise<TurnKnowledge> {
  const isOpening = input.stage === 'opening'
  const ragQuery = isOpening ? OPENING_RAG_QUERY : input.playerText
  const supplementQuery = isOpening ? '' : input.playerText
  const [knowledge, storyName] = await Promise.all([
    fetchKnowledge(input, ragQuery),
    fetchStoryName(input),
  ])
  // P27（预取）+ M1-T6（检索补充）并行：预取是事实层深挖（玩家发言是事实问句且
  // 档案对不上措辞时先跑一次查证，结论并入本轮 system，对玩家不可见——P26 已证
  // 纯提示词无法让 KP 主动查证）；补充层是纹理（ADR-0007）。两者互不依赖，失败
  // 一律静默降级为空。opening 不触发预取（无玩家问句）。
  const [verifyBlock, supplement] = await Promise.all([
    isOpening ? '' : prefetchVerification(input, input.playerText, knowledge),
    fetchTurnSupplement(input, supplementQuery, knowledge),
  ])
  // wire 采样注入列（M1-T6 语义扩展）：注入列 = 场景档案块 + 检索补充小节
  // （此前只有 rag 房的 ragContext）。采样落库的注入文本即"KP 本轮实际看到的
  // 知识块"，供 A/B 报告统计注入量与还原现场。
  const wireInjectionText =
    [knowledge.sceneBlock, supplement].filter((s) => !!s && s.trim().length > 0).join('\n\n') || knowledge.ragContext
  return {
    ragContext: knowledge.ragContext,
    sceneBlock: knowledge.sceneBlock,
    verifyBlock,
    supplement,
    sceneName: knowledge.sceneName,
    coverage: knowledge.coverage,
    storyName,
    wireInjectionText,
  }
}

/** 房间知识注入（workflow 分派）：rag → 检索上下文；dossier → 静态场景块 + 场景 id。
 *  覆盖度随块一并回传（P27 预取判定复用，同一回合不重复读 gaps）。 */
async function fetchKnowledge(
  input: TurnKnowledgeInput,
  ragQuery: string,
): Promise<{ ragContext: string; sceneBlock: string; sceneName?: string; coverage?: SceneCoverage | null }> {
  if (!input.storyId) return { ragContext: '', sceneBlock: '' }
  if (input.workflow === 'dossier') {
    const d = await fetchDossierContext(input)
    return { ragContext: '', sceneBlock: d.block, sceneName: d.sceneName, coverage: d.coverage }
  }
  return { ragContext: await fetchRagContext(input, ragQuery), sceneBlock: '' }
}

/** 剧本名（rag 索引清单 / dossier 档案；失败回退 ''）。 */
async function fetchStoryName(input: TurnKnowledgeInput): Promise<string> {
  if (!input.storyId) return ''
  try {
    if (input.workflow === 'dossier') {
      const { loadDossier } = await import('../rag/dossier/dossierCore.js')
      const dossier = await loadDossier(input.ownerId, input.storyId)
      if (dossier?.storyName) return dossier.storyName
    }
    const { listStories } = await import('./ragService.js')
    return listStories(input.ownerId).find((s) => s.storyId === input.storyId)?.name ?? ''
  } catch {
    return ''
  }
}

/**
 * RAG 房情报块（M1-T6）：**标准管线，无图路径**（ADR-0007 决策 2/3）。
 * query → 嵌入 → 向量召回 → 本地 cross-encoder rerank → 渲染块文本。
 *
 * 与档案房的差别（同一套检索，两种装配语义）：
 *  - `mode: 'plain'`——rag 房没有档案块，所以**不做**档案重叠剔除与场景归属排序
 *    （审查发现：两者都会把 rag 房自己的知识来源删掉/塌成 1 条）；
 *  - `rawQuery`——玩家发言就是检索意图，不套场景名拼接与规则清洗；
 *  - 渲染块文本用 `renderBlock`（跨场景前缀必须保留），不另起小节标题
 *    （那属于档案房的双轨标注）。
 * 剧透硬闸两房共有。失败回退 ''——回合不因检索中断。
 */
async function fetchRagContext(input: TurnKnowledgeInput, query: string): Promise<string> {
  if (!input.storyId) return ''
  try {
    const { buildSupplement, defaultRewrite } = await import('../rag/supplementService.js')
    // renderBlock 取自装配模块本体（纯函数）——不经服务层 re-export，
    // 这样测试桩 supplementService（IO 层）时渲染口径仍是真的。
    const { renderBlock } = await import('../rag/supplementAssembly.js')
    const { buildGetEmbeddingForUser } = await import('./ragService.js')
    const res = await buildSupplement(
      {
        userId: input.ownerId,
        scriptId: input.storyId,
        rawQuery: query,
        sceneName: input.scene ?? undefined,
        mode: 'plain',
        enabled: true,
      },
      {
        getEmbedding: (await buildGetEmbeddingForUser(input.ownerId)) ?? undefined,
        // 标准管线的低分改写对两房一致启用（否则 A/B 对照臂被削——审查发现）
        rewrite: defaultRewrite(input.ownerId),
        onEvent: (e) => {
          if (process.env.KP_LLM_DEBUG === '1') console.error(`[rag-fetch] room=${input.roomId} ${JSON.stringify(e)}`)
        },
      },
    )
    const text = res.blocks.map(renderBlock).join('\n\n')
    if (process.env.KP_LLM_DEBUG === '1') console.error(`[rag-fetch] room=${input.roomId} chars=${text.length} degraded=${res.degraded}`)
    return text
  } catch (err) {
    if (process.env.KP_LLM_DEBUG === '1') console.error(`[rag-fetch-fail] room=${input.roomId} err=${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/**
 * dossier workflow：按当前场景取档案静态块 + 场景清单（场景名归一 + 覆盖度）。
 */
async function fetchDossierContext(
  input: TurnKnowledgeInput,
): Promise<{ block: string; sceneName?: string; coverage?: SceneCoverage | null }> {
  if (!input.storyId) return { block: '' }
  try {
    const { loadDossier, buildSceneBlock, listScenes, findScene, renderSceneUncovered } = await import('../rag/dossier/dossierCore.js')
    const { computeSceneCoverage, loadGaps } = await import('../rag/dossier/coverageGaps.js')
    const dossier = await loadDossier(input.ownerId, input.storyId)
    if (!dossier) return { block: '' }
    const scenes = listScenes(dossier)
    // 场景归属（#53）：房间 scene 为空（新局，还没切过场景）→ 回落档案首场景；
    // **有值但对不上任何档案场景 → 绝不安到别的场景上**（错喂 B 场景的块/在场 NPC/
    // 覆盖率，KP 会照着讲述眼前并不存在的东西）。名字先过 findScene 归一
    // （大小写/包含），与检索补充层、原文查证共用同一套匹配口径。
    const wanted = String(input.scene ?? '').trim()
    const matched = wanted ? findScene(dossier, wanted) : null
    // 回落只在"房间还没有场景"时发生；id 与 name 取自**同一个**已解析场景，
    // 否则空场景会退化成"有块没名字"——补充层的 query 锚与预取的定位窗口全丢。
    const resolved = matched ?? (!wanted ? scenes[0] : undefined)
    const unmatched = !!wanted && !matched
    if (unmatched && process.env.KP_LLM_DEBUG === '1') {
      console.error(
        `[dossier-scene] room=${input.roomId} story=${input.storyId} 房间场景「${wanted}」未匹配到档案场景` +
          `（档案 ${scenes.length} 个：${scenes.slice(0, 8).map((s) => s.name).join('、')}${scenes.length > 8 ? '…' : ''}）→ 不注入场景块`,
      )
    }
    const sceneName = unmatched ? wanted : resolved?.name
    // P26：场景块附覆盖提示（该场景原文有多少未入档）——P25 观测到 KP 缺少
    // "档案可能不全"的信号，从不主动查原文。loadGaps 内部已吞错返回 null。
    // 未覆盖时不取覆盖率：那是别的场景的数据，报出来就是冒充。
    const gaps = unmatched ? null : await loadGaps(input.ownerId, input.storyId)
    const coverage = resolved?.id ? computeSceneCoverage(gaps, resolved.id) : null
    const block = unmatched
      ? renderSceneUncovered(wanted, scenes.map((s) => s.name))
      : buildSceneBlock(dossier, resolved?.id ?? '', coverage)
    return { block, sceneName, coverage }
  } catch (err) {
    // 静默降级为空块（既有约定：注入失败不阻断回合），但留可见诊断——
    // 否则"档案块凭空消失"（含 mock 缺导出这类编程错误）线上无从发现。
    if (process.env.KP_LLM_DEBUG === '1') {
      console.error(`[dossier-scene] room=${input.roomId} story=${input.storyId} 场景块解析失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return { block: '' }
  }
}

/**
 * 检索补充小节（M1-T6 / spec #44 / ADR-0007 决策 5/6）：档案房每回合固定检索一次，
 * 注入 ≤3 块 / ≤1.6k 字符的原文纹理。返回**已渲染小节**（空串 = 不注入）。
 *
 * 只在 dossier workflow 生效；rag 房的情报块本身就是检索产物（标准管线，见 fetchRagContext）。
 * 总开关 `rag.supplement`（默认开）关闭时直接返回 ''——不读档案、不检索、不加载模型。
 * 永不抛出：任何失败都降级为空小节（回合不因纹理补充中断）。
 */
async function fetchTurnSupplement(
  input: TurnKnowledgeInput,
  playerText: string,
  knowledge: { sceneName?: string } = {},
): Promise<string> {
  if (input.workflow !== 'dossier' || !input.storyId) return ''
  try {
    const { getSettings } = await import('./settingsService.js')
    if (getSettings(input.ownerId)?.rag?.supplement === false) return ''
    const { buildSupplement, defaultRewrite } = await import('../rag/supplementService.js')
    const { buildGetEmbeddingForUser } = await import('./ragService.js')
    const res = await buildSupplement(
      {
        userId: input.ownerId,
        scriptId: input.storyId,
        playerText,
        sceneName: knowledge.sceneName ?? input.scene ?? undefined,
        enabled: true,
      },
      {
        getEmbedding: (await buildGetEmbeddingForUser(input.ownerId)) ?? undefined,
        // 低分改写（ADR-0007 决策 6）：仅在检索最高分低于阈值时触发一次
        rewrite: defaultRewrite(input.ownerId),
        onEvent: (e) => {
          if (process.env.KP_LLM_DEBUG === '1') console.error(`[supplement] room=${input.roomId} ${JSON.stringify(e)}`)
          appendTraceFile('SUPPLEMENT_TRACE', input.roomId, input.storyId, e)
        },
      },
    )
    return res.section
  } catch (err) {
    if (process.env.KP_LLM_DEBUG === '1') console.error(`[supplement-fail] room=${input.roomId} err=${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/**
 * P27 预取：事实问句 + 档案对不上措辞 → 服务端先查证，结论并入本轮 system。
 * 仅在 dossier 房生效；任何失败/超时返回 ''（不回填、不阻断回合）。
 * 覆盖度复用 fetchDossierContext 算好的那份（不再单独读 gaps）；查证本身若触发，
 * `verifyOriginal` 会自行读一次 gaps/原文（各有 TTL 缓存）——口径一致，非重复劳动。
 *
 * 动态 import 也包在 try 里（审查）：模块加载失败会让 `Promise.all` 拒绝，
 * 而调用方（flushTurn）没有外层 catch → 整个回合静默丢失。
 */
async function prefetchVerification(
  input: TurnKnowledgeInput,
  playerText: string,
  knowledge: { sceneBlock: string; sceneName?: string; coverage?: SceneCoverage | null },
): Promise<string> {
  if (input.workflow !== 'dossier' || !input.storyId) return ''
  try {
    const { runPrefetch } = await import('../rag/dossier/prefetch.js')
    const res = await runPrefetch(
      { playerText, sceneBlock: knowledge.sceneBlock, sceneName: knowledge.sceneName, coverage: knowledge.coverage ?? null },
      {
        userId: input.ownerId,
        scriptId: input.storyId,
        onEvent: (e) => {
          if (process.env.KP_LLM_DEBUG === '1') console.error(`[prefetch] room=${input.roomId} ${JSON.stringify(e)}`)
          appendTraceFile('PREFETCH_TRACE', input.roomId, input.storyId, e)
        },
      },
    )
    return res?.content ?? ''
  } catch {
    // 预取链路失败（含动态 import 失败）→ 静默降级为空（回合照常）
    return ''
  }
}

/** dossier 查证工具执行器的输入：房间 id 直传；owner/剧本/场景是**运行时活值**——
 *  工具在回合执行中才被调用（transition_to_scene → 随后的 verify_original 应拿到
 *  新场景），经读取器在调用时刻取值，与本模块的无状态约定一致。 */
export interface StoryLookupInput {
  roomId: string
  getWorkflow: () => StoryWorkflow
  getOwnerId: () => number
  getStoryId: () => string | null
  getScene: () => string | null
}

/** dossier workflow 查证工具执行器：按工具名查档案，返回工具结果 content。
 *  rag workflow 返回 undefined（无查证工具）。供 RoomService 的 KP 回合执行器挂接。 */
export function buildStoryLookup(
  input: StoryLookupInput,
): ((toolName: string, args: Record<string, unknown>) => Promise<{ content: string }>) | undefined {
  if (input.getWorkflow() !== 'dossier' || !input.getStoryId()) return undefined
  return async (toolName, args) => {
    const ownerId = input.getOwnerId()
    const storyId = input.getStoryId() as string
    const { loadDossier, listScenes, buildSceneBlock, findScene, lexicalSearch, renderSceneNotFound, renderLexicalMiss } = await import('../rag/dossier/dossierCore.js')
    const { computeSceneCoverage, loadGaps } = await import('../rag/dossier/coverageGaps.js')
    const dossier = await loadDossier(ownerId, storyId)
    if (!dossier) return { content: 'error: 剧本档案不存在' }
    if (toolName === 'scene_list') {
      const scenes = listScenes(dossier)
      if (scenes.length === 0) return { content: '剧本档案中暂无场景。' }
      return { content: scenes.map((s) => `- ${s.name}${s.description ? `：${s.description}` : ''}`).join('\n') }
    }
    if (toolName === 'scene_dossier') {
      const name = String(args.sceneName ?? '').trim()
      if (!name) return { content: 'error: sceneName required' }
      const scene = findScene(dossier, name)
      if (!scene) {
        return { content: renderSceneNotFound(name, listScenes(dossier).map((s) => s.name)) }
      }
      // P26：附场景覆盖提示（缺口归属按 .gaps.json；loadGaps 内部已吞错返回 null）
      const gaps = await loadGaps(ownerId, storyId)
      const coverage = gaps ? computeSceneCoverage(gaps, scene.id) : null
      return { content: buildSceneBlock(dossier, scene.id, coverage) }
    }
    if (toolName === 'lexical_search') {
      const query = String(args.query ?? '').trim()
      if (!query) return { content: 'error: query required' }
      const hits = lexicalSearch(dossier, query, 5)
      if (hits.length === 0) return { content: renderLexicalMiss(query) }
      return { content: hits.map((h) => `[${h.kind}] ${h.name}${h.text ? `：${h.text.slice(0, 200)}` : ''}`).join('\n') }
    }
    if (toolName === 'verify_original') {
      // P25 运行时原文查证：场景锚点窗口 → 全新上下文子阅读器（剧透层标注随内容）。
      // 缺省场景 = 房间当前场景；内部失败一律降级为「未取得」文本（不阻断回合）。
      const question = String(args.question ?? '').trim()
      if (!question) return { content: 'error: question required' }
      const sceneArg = String(args.scene ?? '').trim() || input.getScene() || undefined
      const { verifyOriginal } = await import('../rag/dossier/originalLookup.js')
      const res = await verifyOriginal(
        { question, scene: sceneArg },
        { userId: ownerId, scriptId: storyId },
      )
      if (process.env.KP_LLM_DEBUG === '1') {
        console.error(`[verify-original] room=${input.roomId} scene=${sceneArg ?? ''} tier=${res.meta.tier} chars=${res.meta.chars} ok=${res.meta.ok} ${res.meta.durationMs}ms`)
      }
      return { content: res.content }
    }
    return { content: `error: unknown tool "${toolName}"` }
  }
}
