/**
 * Dossier lookup-tool executor — 档案域的查证工具执行器（架构走查候选 3）。
 *
 * KP 回合内可调用的四个只读查证工具（scene_list / scene_dossier / lexical_search /
 * verify_original）的**执行语义全部落在档案域**：回包文案（renderSceneNotFound /
 * renderLexicalMiss / buildSceneBlock /「未取得」）与数据源（loadDossier /
 * coverageGaps / originalLookup）都是本目录的模块——此前执行器本体却住在房间域
 * （RoomService 闭包 → 候选 1 收编进 turnKnowledge），概念落点错位。本模块把
 * 「执行器本体」归还档案域：turnKnowledge 只保留「回合内要不要提供查证工具」的
 * workflow 门并动态 import 委托到这里（房间域不背档案查询链，工具调用时才加载）。
 *
 * 加一个查证工具的触点：wire schema 在 `shared/tools/storyLookupTools.ts`（同时是
 * 训练评测侧契约）、执行分支在本模块、提示词工具罗列在 kpPromptService（提示词契约，
 * 刻意不抽象）。
 *
 * 活值 getter 设计：工具在回合执行中才被调用（transition_to_scene → 随后的
 * verify_original 应拿到新场景；房主转让可能发生在同回合内），owner/剧本/场景经
 * 读取器在**调用时刻**取值，本模块不持有任何房间状态。
 *
 * 降级语义（既有约定，逐点保持）：回包文本即降级——档案缺失回 error 文案、查证
 * 内部失败由 originalLookup 降级为「未取得」、缺参回 error 文案；执行器自身不吞
 * 异常，残余异常由 kpTurnService 的 try/catch 兜底为 error 回包（回合不阻断）。
 * 对 dossierCore / coverageGaps / originalLookup 保持动态 import（轻核，Mimosa
 * 门禁安全边界：本模块静态图上不牵连任何重依赖链）。
 */
import type { StoryWorkflow } from '../../services/kpPromptService.js'

/** dossier 查证工具执行器的输入：房间 id 直传；owner/剧本/场景是**运行时活值**——
 *  经读取器在工具调用时刻取值（工厂门在装配时刻判定一次，活值语义见模块头注释）。 */
export interface StoryLookupInput {
  roomId: string
  getWorkflow: () => StoryWorkflow
  getOwnerId: () => number
  getStoryId: () => string | null
  getScene: () => string | null
}

/** 查证工具执行器：按工具名查档案，返回工具结果 content（kpTurnService seam 形态）。 */
export type StoryLookupHandler = (toolName: string, args: Record<string, unknown>) => Promise<{ content: string }>

/**
 * 执行器本体（dossier workflow 已由工厂门判定）：按工具名查档案，返回工具结果
 * content。任何可预期失败都以回包文本降级（不抛出、不阻断回合）。
 */
export async function runStoryLookup(
  input: StoryLookupInput,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: string }> {
  const ownerId = input.getOwnerId()
  const storyId = input.getStoryId() as string
  const { loadDossier, listScenes, buildSceneBlock, findScene, lexicalSearch, renderSceneNotFound, renderLexicalMiss } = await import('./dossierCore.js')
  const { computeSceneCoverage, loadGaps } = await import('./coverageGaps.js')
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
    const { verifyOriginal } = await import('./originalLookup.js')
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
