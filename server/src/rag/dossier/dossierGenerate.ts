/**
 * Dossier generator — the dossier workflow's heavy generation half.
 *
 * 拆分约定（架构走查候选 2）：生成期路由（POST /api/dossier/:scriptId/generate
 * 与测试）独享的模块——**静态**引入 storyService（readStoryForRag → jsdom/pdf-lib
 * 解析链）、aiService（chatForRag）、annex（map annex 视觉通道）、prompts，以及
 * 轻核 `./dossierCore.js`（落盘走 persist）与 schema/coverageGaps。查询期消费方
 * 不要 import 本模块（轻查询核在 `./dossierCore.js`；兼容门面在
 * `./storyDossierService.ts`）。
 *
 * The chat path goes through `chatForRag` (aiService) so it inherits protocol
 * dispatch + URL safety + the MOCK_AI script. In MOCK_AI mode the script
 * returns deterministic JSON for dossier prompts (see mockAi.ts), so e2e can
 * run the whole dossier flow without an LLM.
 */
import { readStoryForRag, readStory } from '../../services/storyService.js'
import { chatForRag } from '../../services/aiService.js'
import {
  DOSSIER_BATCH_CHARS,
  DOSSIER_SYSTEM_PROMPT,
  buildDossierPrompt,
  mergeDossierParts,
} from './prompts.js'
import {
  parseDossierJson,
  resolveRefs,
  assessDossier,
  type StoryDossier,
  type DossierQualitySummary,
} from './schema.js'
import { persistAnnex, runAnnex } from './annex.js'
import { computeCoverageGaps, persistGaps } from './coverageGaps.js'
import { persist } from './dossierCore.js'

/** Max raw story chars fed to the generator overall (safety; ~170k max known). */
const MAX_GENERATE_CHARS = 200_000
/** Max generation batches per story (safety). */
const MAX_BATCHES = 24
/**
 * #55 生成期重试预算：每节最多 4 次尝试。前两次原额重发（上游偶发 400/503/
 * 空响应），后两次抬 maxTokens（见 DOSSIER_GEN_MAX_TOKENS_ESCALATED）。
 */
const DOSSIER_GEN_ATTEMPTS = 4
/** 单节生成 maxTokens：推理模型 reasoning 吃 output budget，8k 曾致分节解析空（P13 抬到 16k）。 */
const DOSSIER_GEN_MAX_TOKENS = 16384
/**
 * 重试后段抬到的 maxTokens：temp=0 下原样重发近似复现同一截断（#55 实测
 * 生成 A 三节连挂 4 次重发全灭），抬上限是唯一不动提示词/批大小的自愈杠杆；
 * 端点若拒绝更大值会抛 400 → 计入失败，不劣于现状。
 */
const DOSSIER_GEN_MAX_TOKENS_ESCALATED = 32768

export interface GenerateResult {
  ok: boolean
  scriptId?: string
  scenes?: number
  clues?: number
  npcs?: number
  transitions?: number
  events?: number
  truths?: number
  endings?: number
  /** 结构质量告警（不阻断；见 assessDossier）。 */
  warnings?: string[]
  /** 档案 sceneText 覆盖剧本原文比例（%）。 */
  coveragePct?: number
  /**
   * #55 降质标记：低覆盖（< DOSSIER_MIN_COVERAGE_PCT，仅对 >5000 字符剧本）
   * 或分节解析失败。已随档案落盘（quality 快照）——开局门闩据此拒绝开局。
   */
  degraded?: boolean
  /** annex（图信息通道）统计；annex 未跑时为 undefined（见 runAnnex）。 */
  annexImages?: number
  annexDrops?: number
  annexFailed?: number
  annexPending?: number
  annexTransitions?: number
  annexClues?: number
  /** coverage gaps（原文覆盖缺口）：gapCount/gapChars/gapPct（明细在 .gaps.json）。 */
  gapCount?: number
  gapChars?: number
  gapPct?: number
  error?: string
}

/* ═══════════════════ Generation ═══════════════════ */

/** Split raw story text into sequential sections for batched LLM extraction. */
export function splitStorySections(content: string, batchChars: number = DOSSIER_BATCH_CHARS): string[] {
  const text = String(content ?? '').trim()
  if (!text) return []
  if (text.length <= batchChars) return [text]
  const sections: string[] = []
  let rest = text
  // Prefer splitting at markdown-ish headings / blank-line paragraph gaps.
  while (rest.length > batchChars) {
    const head = rest.slice(0, batchChars)
    const lastBreak = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n#'), head.lastIndexOf('\n##'), head.lastIndexOf('\n###'))
    const cutAt = lastBreak >= batchChars * 0.5 ? lastBreak : head.length
    sections.push(rest.slice(0, cutAt).trim())
    rest = rest.slice(cutAt).trim()
  }
  if (rest) sections.push(rest)
  return sections
}

/**
 * Generate a dossier for a user's story. `model` overrides settings. Reads the
 * story text via readStoryForRag (PDF → parsePdfWithOcr). Batches long stories;
 * feeds previously-seen names back for cross-batch consistency.
 */
export async function generateDossier(
  userId: number,
  scriptId: string,
  options: { model?: string; annex?: boolean } = {},
): Promise<GenerateResult> {
  const { model, annex } = options
  if (!scriptId) return { ok: false, error: 'missing scriptId' }

  let raw: { name: string; content: string }
  try {
    raw = await readStoryForRag(userId, scriptId)
  } catch {
    // Fall back to the plain read for txt/md (no OCR needed).
    try {
      raw = await readStory(userId, scriptId)
    } catch {
      return { ok: false, error: 'story not found' }
    }
  }
  const content = (raw?.content || '').trim()
  if (!content) return { ok: false, error: 'story content is empty' }

  const storyText = content.slice(0, MAX_GENERATE_CHARS)
  const sections = splitStorySections(storyText)
  const batches = sections.slice(0, MAX_BATCHES)
  const totalBatches = batches.length

  const seenSceneNames: string[] = []
  const seenNpcNames: string[] = []
  const seenClueDescriptions: string[] = []
  const parsedParts: StoryDossier[] = []
  let lastError = ''
  let batchFailures = 0

  for (let bi = 0; bi < totalBatches; bi++) {
    const prompt = buildDossierPrompt({
      batchIndex: bi,
      storyText: batches[bi],
      seenSceneNames,
      seenNpcNames,
      seenClueDescriptions,
    })
    // #55：同一节内重试——parse 失败与 chatForRag 抛错（上游 400/503/超时）都算
    // 一次失败尝试；后段尝试抬 maxTokens（temp=0 下原样重发自愈不了确定性截断）。
    let parsed: StoryDossier | null = null
    let lastBatchError = ''
    for (let attempt = 0; attempt < DOSSIER_GEN_ATTEMPTS && !parsed; attempt++) {
      try {
        const res = await chatForRag(userId, {
          messages: [
            { role: 'system', content: DOSSIER_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          maxTokens: attempt < 2 ? DOSSIER_GEN_MAX_TOKENS : DOSSIER_GEN_MAX_TOKENS_ESCALATED,
          model,
        })
        parsed = parseDossierJson(stripCodeFence(res?.content || ''))
        if (!parsed) lastBatchError = '解析结果为空/无效 JSON'
      } catch (e) {
        lastBatchError = e instanceof Error ? e.message : String(e)
      }
    }
    if (parsed && parsed.scenes.length + parsed.clues.length + parsed.npcs.length + (parsed.transitions?.length ?? 0) + (parsed.events?.length ?? 0) + (parsed.truths?.length ?? 0) + (parsed.endings?.length ?? 0) > 0) {
      parsedParts.push({
        ...parsed,
        scriptId: parsed.scriptId || scriptId,
        storyName: parsed.storyName || raw.name || scriptId,
        generatedByModel: parsed.generatedByModel || model,
      })
      for (const s of parsed.scenes) if (s.name && !seenSceneNames.includes(s.name)) seenSceneNames.push(s.name)
      for (const n of parsed.npcs) if (n.name && !seenNpcNames.includes(n.name)) seenNpcNames.push(n.name)
      for (const c of parsed.clues) if (c.description && !seenClueDescriptions.includes(c.description)) seenClueDescriptions.push(c.description)
    } else {
      lastError = `batch ${bi + 1}/${totalBatches}: ${lastBatchError || '解析结果为空'}`
      batchFailures++
    }
  }

  if (parsedParts.length === 0) {
    return { ok: false, error: lastError || 'dossier generation failed' }
  }

  const merged = mergeDossierParts(parsedParts)
  const resolved = resolveRefs(merged)
  let dossier: StoryDossier = {
    ...resolved,
    scriptId,
    storyName: resolved.storyName || raw.name || scriptId,
    generatedAt: Date.now(),
    generatedByModel: resolved.generatedByModel || model,
  }

  // map annex（P18）：抽图→视觉→铁律 2 筛选→保守合并。annex 失败不阻断档案
  // 生成（warnings 记一笔）；模型守卫/协议守卫错误同样降级为告警。
  let annexNote = ''
  let annexRan = false
  if (annex) {
    try {
      const annexResult = await runAnnex(userId, { scriptId, storyName: dossier.storyName, dossier, model })
      dossier = annexResult.dossier
      await persistAnnex(userId, annexResult.annex)
      annexRan = true
      annexNote = annexResult.annex.note ?? ''
    } catch (e) {
      annexNote = `annex 未运行：${e instanceof Error ? e.message : String(e)}`
    }
  }

  // coverage gaps（P22）：本地计算原文未被 sceneText 覆盖的区间 + 场景锚点，
  // 落盘 .gaps.json（回退定位/质量门用）；失败不阻断生成。
  let gapsRan = false
  try {
    const gaps = computeCoverageGaps(storyText, dossier.scenes)
    await persistGaps(userId, {
      ...gaps,
      scriptId,
      storyName: dossier.storyName,
      generatedAt: Date.now(),
    })
    dossier = { ...dossier, coverageGaps: { count: gaps.gapCount, chars: gaps.gapChars, pct: gaps.gapPct, at: Date.now() } }
    gapsRan = true
  } catch {
    // gaps 失败仅缺失定位明细，不影响档案
  }

  const quality = assessDossier(dossier, storyText.length)
  const warnings: string[] = [...quality.warnings]
  if (annex && annexNote) warnings.push(annexNote)
  if (batchFailures > 0 && parsedParts.length < totalBatches) {
    warnings.push(`有 ${batchFailures} 个分节解析失败，档案只覆盖前 ${parsedParts.length}/${totalBatches} 节——内容不完整`)
  }

  // #55：生成期质量快照随档案落盘——开局门闩（startRoom / createSoloRoom）据此
  // 拒绝残档开局，不再静默放行。分节失败独立于覆盖率计入：小节失败可能拉不低
  // 覆盖率，但档案依旧不完整。
  const degraded = quality.degraded || batchFailures > 0
  const qualitySummary: DossierQualitySummary = {
    coveragePct: quality.coveragePct,
    degraded,
    failedBatches: batchFailures > 0 ? batchFailures : undefined,
    at: Date.now(),
  }
  dossier = { ...dossier, quality: qualitySummary }

  await persist(userId, dossier)
  const result: GenerateResult = {
    ok: true,
    scriptId,
    scenes: dossier.scenes.length,
    clues: dossier.clues.length,
    npcs: dossier.npcs.length,
    transitions: dossier.transitions?.length ?? 0,
    events: dossier.events?.length ?? 0,
    truths: dossier.truths?.length ?? 0,
    endings: dossier.endings?.length ?? 0,
    warnings: warnings.length ? warnings : undefined,
    coveragePct: quality.coveragePct,
    degraded,
  }
  if (annex && annexRan) {
    result.annexImages = quality.annexImages
    result.annexDrops = quality.annexDrops
    result.annexFailed = quality.annexFailed
    result.annexPending = quality.annexPending
    result.annexTransitions = quality.annexTransitions
    result.annexClues = quality.annexClues
  }
  if (gapsRan) {
    result.gapCount = quality.gapCount
    result.gapChars = quality.gapChars
    result.gapPct = quality.gapPct
  }
  return result
}

/** Strip ```json … ``` fences that some models add despite instructions. */
export function stripCodeFence(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return s
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced && fenced[1]) return fenced[1].trim()
  return s
}
