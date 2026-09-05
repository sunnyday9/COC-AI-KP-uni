/**
 * 评测编排（T3 #39）：加载金样本 → 逐样本构建线上同形请求 → 调端点 → 判定 →
 * 汇总报告（格式遵循率 / 裁定正确率 / 可分类失败明细 / 24 工具覆盖）。
 * 并发用简单 worker pool；端点错误不计入比率（单独列出，避免污染模型行为数字）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { COC_TOOL_NAMES } from '../../../shared/tools/cocTools.ts'
import { callTurn, EndpointError, type EvalEndpoint } from './client.ts'
import { judgeSample } from './judge.ts'
import { buildTurnRequest } from './request.ts'
import type { GoldenSample, SampleJudgement } from './types.ts'

export interface EvalOptions {
  endpoint: EvalEndpoint
  samplesPath: string
  concurrency: number
  limit?: number
}

export interface EvalReport {
  schemaVersion: 1
  createdAt: string
  endpoint: { baseUrl: string; model: string; temperature: number; maxTokens: number }
  sampleCount: number
  judgedCount: number
  formatRate: number
  verdictRate: number
  failureBreakdown: Record<string, number>
  failures: { id: string; category: string; detail: string; formatOk: boolean; verdictOk: boolean }[]
  perTool: { tool: string; samples: number; formatPass: number; verdictPass: number }[]
  toolCoverage: { tool: string; covered: boolean }[]
  endpointErrors: { id: string; message: string }[]
  usage: { promptTokens: number; completionTokens: number }
  durationMs: number
}

/** 载入并结构校验金样本集（作者编辑 golden-samples.json 时的第一道护栏）。
 * 角色卡本体单点在 characters.json，样本用 characters[] 引用，这里解析回填。 */
export function loadSamples(samplesPath: string): GoldenSample[] {
  const raw = JSON.parse(readFileSync(samplesPath, 'utf8')) as { version?: number; samples?: GoldenSample[] }
  const samples = raw.samples
  if (!Array.isArray(samples) || samples.length === 0) throw new Error(`${samplesPath}: 缺少非空 samples[]`)
  const cardsPath = resolve(dirname(samplesPath), 'characters.json')
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8')) as { characters: Record<string, unknown> }
  const errors: string[] = []
  const seen = new Set<string>()
  for (const s of samples) {
    const where = `样本 ${s.id ?? '(无 id)'}`
    if (!s.id || seen.has(s.id)) errors.push(`${where}: id 缺失或重复`)
    seen.add(s.id)
    if (!s.batchUserContent) errors.push(`${where}: batchUserContent 缺失`)
    if (!s.expect) errors.push(`${where}: expect 缺失`)
    else if (!s.expect.noTools && (!Array.isArray(s.expect.alternatives) || s.expect.alternatives.length === 0)) {
      errors.push(`${where}: expect.alternatives 为空（纯叙事样本应设 noTools: true）`)
    }
    if (!Array.isArray(s.tools)) errors.push(`${where}: tools[] 缺失（覆盖度统计需要；纯叙事样本为空数组）`)
    if (!s.notes) errors.push(`${where}: notes 缺失（人工复核注记是验收要求）`)
    if (!s.storyName) errors.push(`${where}: storyName 缺失`)
    if (s.characters?.length) {
      const byId: Record<string, unknown> = {}
      for (const id of s.characters) {
        const card = cards.characters[id]
        if (!card) {
          errors.push(`${where}: 角色卡 ${id} 不在 characters.json`)
          continue
        }
        byId[id] = card
      }
      s.charactersById = byId as GoldenSample['charactersById']
    }
  }
  if (errors.length) throw new Error(`金样本集结构校验失败:\n- ${errors.join('\n- ')}`)
  return samples
}

/** 24 工具覆盖校验：返回每个工具是否有样本覆盖。覆盖来源 = 样本 tools[] 声明
 * ∪ expect.alternatives 里实际出现的工具名（后者防「声明虚增覆盖」）。 */
export function toolCoverage(samples: GoldenSample[]): { tool: string; covered: boolean }[] {
  const covered = new Set<string>()
  for (const s of samples) {
    for (const t of s.tools) covered.add(t)
    for (const seq of s.expect.alternatives) for (const c of seq) covered.add(c.name)
  }
  return COC_TOOL_NAMES.map((t) => ({ tool: t, covered: covered.has(t) }))
}

export async function runEval(opts: EvalOptions): Promise<{ report: EvalReport; judged: (SampleJudgement & { tools: string[] })[] }> {
  const startedAt = Date.now()
  const samples = loadSamples(opts.samplesPath)
  const selected = opts.limit ? samples.slice(0, opts.limit) : samples

  const coverage = toolCoverage(samples)
  const uncovered = coverage.filter((c) => !c.covered).map((c) => c.tool)
  if (uncovered.length) console.warn(`[warn] 以下工具无样本覆盖: ${uncovered.join(', ')}`)

  const judged: (SampleJudgement & { tools: string[] })[] = []
  const endpointErrors: { id: string; message: string }[] = []
  const usage = { promptTokens: 0, completionTokens: 0 }
  const tools = (await import('../../../shared/tools/cocTools.ts')).COC_KP_TOOLS

  let cursor = 0
  async function worker() {
    while (cursor < selected.length) {
      const sample = selected[cursor++]
      try {
        const messages = buildTurnRequest(sample)
        const result = await callTurn(opts.endpoint, messages, tools)
        usage.promptTokens += result.usage.promptTokens
        usage.completionTokens += result.usage.completionTokens
        judged.push({ ...judgeSample(sample, { content: result.content, toolCalls: result.toolCalls }), tools: sample.tools })
      } catch (err) {
        const message = err instanceof EndpointError ? err.message : String(err)
        endpointErrors.push({ id: sample.id, message })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker))

  const formatPass = judged.filter((j) => j.formatOk).length
  const verdictPass = judged.filter((j) => j.verdictOk).length
  const breakdown: Record<string, number> = {}
  for (const j of judged) {
    if (j.category !== 'pass') breakdown[j.category] = (breakdown[j.category] ?? 0) + 1
  }

  const toolSet = [...new Set(selected.flatMap((s) => s.tools))]
  const perTool = toolSet
    .map((tool) => {
      const js = judged.filter((j) => j.tools.includes(tool))
      return {
        tool,
        samples: js.length,
        formatPass: js.filter((j) => j.formatOk).length,
        verdictPass: js.filter((j) => j.verdictOk).length,
      }
    })
    .sort((a, b) => a.tool.localeCompare(b.tool))

  const report: EvalReport = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    endpoint: {
      baseUrl: opts.endpoint.baseUrl,
      model: opts.endpoint.model,
      temperature: opts.endpoint.temperature,
      maxTokens: opts.endpoint.maxTokens,
    },
    sampleCount: selected.length,
    judgedCount: judged.length,
    formatRate: judged.length ? formatPass / judged.length : 0,
    verdictRate: judged.length ? verdictPass / judged.length : 0,
    failureBreakdown: breakdown,
    failures: judged
      .filter((j) => j.category !== 'pass')
      .map((j) => ({ id: j.id, category: j.category, detail: j.detail, formatOk: j.formatOk, verdictOk: j.verdictOk })),
    perTool,
    toolCoverage: coverage,
    endpointErrors,
    usage,
    durationMs: Date.now() - startedAt,
  }
  return { report, judged }
}
