/**
 * KP 蒸馏数据生成 CLI（T4，spec #36 / 票 #40 / ADR-0006 决策 4）。
 *
 * 用法（training 工作区内）：
 *   npm run distill -- corpus                        # 语料抽取+切块+检索索引（缓存）
 *   npm run distill -- plan   [--rollouts 400] [--seed 20260906]
 *                                                    # 卡池+rollout 计划+train/heldout 指派
 *   npm run distill -- run    [--limit N] [--concurrency 3] [--seed-replay] [--no-seed] [--no-synth]
 *                                                    # Phase A+B 融合：seed 重放 + rollout 蒸馏
 *   npm run distill -- anchors [--limit N]           # 金样本×#39裁定锚 + mock/e2e 锚
 *   npm run distill -- pack                          # train/held-out 切分 + 统计（datacard.json）
 *   npm run distill -- audit  [--target 60]          # 分层抽检包（清单/查看器）
 *
 * IO 边界（与 #38 导出器同尺度）：
 * IO 路径全部为模块常量（仓库内定位：语料 AI-COC-KP Story Document/、
 * DB server/data/ai-kp.db、产物 training/out/distill/）；教师凭据只走环境变量：
 * KP_DISTILL_BASE_URL / KP_DISTILL_API_KEY / KP_DISTILL_MODEL。
 *
 * run 阶段断点续跑：samples.jsonl / rejected.jsonl 按 skeletonId 去重，中断后重跑
 * 同命令自动跳过已完成的回合。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalEndpoint } from '../../eval/lib/client.js'
import { LexicalIndex, loadCorpus, buildCorpusChunks, type CorpusChunk } from './corpus.js'
import { buildSeedSkeletons } from './seeds.js'
import { loadSheetPool, planRollouts, type RolloutPlan } from './pool.js'
import { applyTurnOutcome, buildSkeleton, initRolloutState, restoreState, snapshotState, synthesizeBatch } from './synth.js'
import { replaySkeleton } from './replay.js'
import { filterTurn } from './filter.js'
import { buildSample } from './sample.js'
import { buildGoldenAnchors, buildMockAnchorSeeds, loadDemoStoryText, mockAnchorSkeleton } from './anchors.js'
import { packSplit, computeStats, toolAppearance, stratifyAudit, buildAuditPack } from './pack.js'
import { teacherEndpointFromEnv } from './teacher.js'
import type { DistillSample, DistillSkeleton, ReplayedTurn, TurnType } from './types.js'

/* ── 路径与环境 ─────────────────────────────────────────────── */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
/**
 * IO 路径全部为模块常量（纯 join，零 argv/env 参与）——D-09「外部输入不进 fs
 * 路径」的断链方案：蒸馏管线的语料/DB/产物固定仓库内定位（Kaggle 侧路径属 #41），
 * 教师凭据是唯一的 env 输入（只进 openai SDK，不落路径）。
 */
const OUT_DIR = path.join(REPO_ROOT, 'training', 'out', 'distill')
const CORPUS_ROOT = path.join(REPO_ROOT, 'AI-COC-KP Story Document')
const SERVER_DB = path.join(REPO_ROOT, 'server', 'data', 'ai-kp.db')
const CORPUS_FILE = path.join(OUT_DIR, 'corpus.json')
const PLAN_FILE = path.join(OUT_DIR, 'plan.json')
const SAMPLES_FILE = path.join(OUT_DIR, 'samples.jsonl')
const REJECTED_FILE = path.join(OUT_DIR, 'rejected.jsonl')
const ANCHORS_FILE = path.join(OUT_DIR, 'anchors.jsonl')
const TRAIN_FILE = path.join(OUT_DIR, 'train.jsonl')
const HELDOUT_FILE = path.join(OUT_DIR, 'heldout.jsonl')
const DATACARD_FILE = path.join(OUT_DIR, 'datacard.json')
/** Phase A（合成批次）的教师用量台账——Phase B 用量已在 sample/rejected 行内。 */
const USAGE_LEDGER_FILE = path.join(OUT_DIR, 'usage.jsonl')
/** 人工示范入口（可选）：用户提供时并入训练侧（票 #40「少量人工示范并入」）。 */
const HUMAN_FILE = path.join(REPO_ROOT, 'training', 'data', 'human-samples.jsonl')

function ensureOutDir(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T)
}

function appendJsonl(file: string, rows: unknown[]): void {
  if (rows.length === 0) return
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
}

/** 教师用量台账（Phase A 等不落入样本/拒绝行的调用；数据卡成本 = 三处求和）。 */
function appendUsage(usage: { promptTokens: number; completionTokens: number; calls: number }): void {
  if (usage.calls === 0) return
  fs.appendFileSync(USAGE_LEDGER_FILE, JSON.stringify({ at: new Date().toISOString(), ...usage }) + '\n', 'utf-8')
}

/* ── CLI 参数 ─────────────────────────────────────────────── */

interface CliArgs {
  stage: string
  rollouts: number
  seed: number
  limit: number
  concurrency: number
  noSeed: boolean
  noSynth: boolean
}

const USAGE = `用法: npm run distill -- <corpus|plan|run|anchors|pack|audit> [选项]
  --rollouts N      rollout 数量（plan，缺省 400）
  --seed N          随机种子（plan，缺省 20260906）
  --limit N         本轮最多处理 N 个单元（run/anchors 冒烟用）
  --concurrency N   并发（run/anchors，缺省 3）
  --no-seed         run 阶段跳过 seed 重放
  --no-synth        run 阶段跳过合成 rollout`

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0) throw new Error(USAGE)
  const args: CliArgs = {
    stage: argv[0]!,
    rollouts: 400,
    seed: 20260906,
    limit: 0,
    concurrency: 3,
    noSeed: false,
    noSynth: false,
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 缺少参数值\n${USAGE}`)
      return v
    }
    switch (a) {
      case '--rollouts': args.rollouts = Number(next()); break
      case '--seed': args.seed = Number(next()); break
      case '--limit': args.limit = Number(next()); break
      case '--concurrency': args.concurrency = Number(next()); break
      case '--no-seed': args.noSeed = true; break
      case '--no-synth': args.noSynth = true; break
      default: throw new Error(`未知参数: ${a}\n${USAGE}`)
    }
  }
  return args
}

/* ── 阶段实现 ─────────────────────────────────────────────── */

interface CorpusState {
  builtAt: string
  corpusRoot: string
  docs: { storyId: string; name: string; chars: number }[]
  chunks: CorpusChunk[]
  warnings: string[]
}

async function stageCorpus(args: CliArgs): Promise<void> {
  ensureOutDir()
  console.log(`语料根: ${CORPUS_ROOT}`)
  const { docs, warnings } = await loadCorpus(CORPUS_ROOT)
  const chunks = buildCorpusChunks(docs)
  const state: CorpusState = {
    builtAt: new Date().toISOString(),
    corpusRoot: CORPUS_ROOT,
    docs: docs.map((d) => ({ storyId: d.storyId, name: d.name, chars: d.text.length })),
    chunks,
    warnings,
  }
  fs.writeFileSync(CORPUS_FILE, JSON.stringify(state), 'utf-8')
  console.log(`语料构建完成: ${docs.length} 个故事 → ${chunks.length} 个 chunk → ${CORPUS_FILE}`)
  for (const w of warnings) console.warn(`  [警告] ${w}`)
}

interface PlanState {
  seed: number
  rollouts: (RolloutPlan & { split: 'train' | 'heldout' })[]
  heldoutSeedProvenance: string[]
  seedSkeletonIds: string[]
  warnings: string[]
}

/** 出处级 held-out 指派：rollout 按 id 稳定哈希（种子固定，重跑可复现）。 */
function assignSplit(id: string, seed: number): 'train' | 'heldout' {
  let h = seed >>> 0
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) >>> 0
  }
  // held-out 配比：只需 ≥500 条验收线（数据侧最终定稿 18%；计划阶段 30% 是余量估值，
  // 过滤通过率稳定后收紧，把余量还给训练侧）
  return h % 100 < 18 ? 'heldout' : 'train'
}

async function stagePlan(args: CliArgs): Promise<void> {
  ensureOutDir()
  if (!fs.existsSync(CORPUS_FILE)) throw new Error('先运行 corpus 阶段构建语料缓存')
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf-8')) as CorpusState
  const dbPath = SERVER_DB
  const { entries, warnings: poolWarnings } = loadSheetPool(dbPath)
  const { plans, warnings: planWarnings } = planRollouts({
    storyNames: corpus.docs.map((d) => d.name),
    sheetPool: entries,
    count: args.rollouts,
    seed: args.seed,
  })
  const seeds = buildSeedSkeletons(dbPath)
  const state: PlanState = {
    seed: args.seed,
    rollouts: plans.map((p) => ({ ...p, split: assignSplit(p.rolloutId, args.seed) })),
    heldoutSeedProvenance: [...new Set(seeds.skeletons.map((s) => s.originId))].filter((id) => assignSplit(`seed:${id}`, args.seed) === 'heldout'),
    seedSkeletonIds: seeds.skeletons.map((s) => s.id),
    warnings: [...poolWarnings, ...planWarnings, ...seeds.warnings],
  }
  fs.writeFileSync(PLAN_FILE, JSON.stringify(state), 'utf-8')
  const heldout = state.rollouts.filter((r) => r.split === 'heldout').length
  console.log(
    `计划完成: ${state.rollouts.length} rollouts（held-out ${heldout} / train ${state.rollouts.length - heldout}）+ seed 骨架 ${seeds.skeletons.length} 条 → ${PLAN_FILE}`,
  )
  for (const w of state.warnings) console.warn(`  [警告] ${w}`)
}

interface RejectedRow {
  skeletonId: string
  turnType: string
  source: string
  /** 教师模型（教师切换后分桶；无此字段 = 初版教师）。 */
  teacher?: string
  category: string
  detail: string
  usage: { promptTokens: number; completionTokens: number; calls: number }
}

/** 单个重放回合的公共收口：过滤 → 采样 → 落盘或记拒绝。 */
function settleTurn(turn: ReplayedTurn, source: 'seed' | 'synthetic' | 'anchor', teacher?: string): { sample: DistillSample | null; rejected: RejectedRow | null } {
  const verdict = filterTurn(turn)
  if (!verdict.ok) {
    return {
      sample: null,
      rejected: {
        skeletonId: turn.skeleton.id,
        turnType: turn.skeleton.turnType,
        source,
        ...(teacher ? { teacher } : {}),
        category: verdict.category,
        detail: verdict.detail,
        usage: turn.usage,
      },
    }
  }
  return { sample: buildSample(turn, source, teacher), rejected: null }
}

async function stageRun(args: CliArgs): Promise<void> {
  ensureOutDir()
  const ep = teacherEndpointFromEnv()
  const dbPath = SERVER_DB
  const plan: PlanState | null = fs.existsSync(PLAN_FILE) ? JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8')) : null

  // 断点续跑索引
  const done = new Set<string>()
  for (const s of readJsonl<DistillSample>(SAMPLES_FILE)) done.add(s.meta.id)
  for (const r of readJsonl<RejectedRow>(REJECTED_FILE)) done.add(r.skeletonId)

  let corpus: CorpusState | null = null
  if (fs.existsSync(CORPUS_FILE)) corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf-8')) as CorpusState
  const ragIndex = corpus && corpus.chunks.length ? new LexicalIndex(corpus.chunks) : null

  let processed = 0
  let accepted = 0
  let rejected = 0
  const startedAt = Date.now()
  const counters = { samplesOut: [] as DistillSample[], rejectedOut: [] as RejectedRow[] }
  let flushTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    appendJsonl(SAMPLES_FILE, counters.samplesOut.splice(0))
    appendJsonl(REJECTED_FILE, counters.rejectedOut.splice(0))
  }, 5000)

  const record = (result: { sample: DistillSample | null; rejected: RejectedRow | null }): void => {
    processed++
    if (result.sample) {
      accepted++
      counters.samplesOut.push(result.sample)
      done.add(result.sample.meta.id)
    } else if (result.rejected) {
      rejected++
      counters.rejectedOut.push(result.rejected)
      done.add(result.rejected.skeletonId)
    }
  }

  /* 1) seed 重放：真实玩家行动批次（无 Phase A；rollout 状态无关，可并发） */
  const seedWork = async (): Promise<void> => {
    const seeds = buildSeedSkeletons(dbPath)
    for (const w of seeds.warnings) console.warn(`  [警告] ${w}`)
    let cursor = 0
    async function worker() {
      while (cursor < seeds.skeletons.length) {
        const skeleton = seeds.skeletons[cursor++]!
        if (args.limit && processed >= args.limit) return
        if (done.has(skeleton.id)) continue
        try {
          record(settleTurn(await replaySkeleton(ep, skeleton), 'seed', ep.model))
        } catch (err) {
          console.warn(`  [seed 失败] ${skeleton.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))
  }

  /* 2) 合成 rollout：Phase A 批次 + Phase B 重放逐回合推进（rollout 级并发） */
  const synthWork = async (): Promise<void> => {
    if (!plan) throw new Error('先运行 plan 阶段生成 rollout 计划')
    if (!ragIndex) throw new Error('语料索引缺失（corpus 阶段未产出 chunk）——合成 rollout 需要故事情报')
    const planState = plan
    const index = ragIndex
    const byStory = new Map<string, CorpusChunk[]>()
    for (const chunk of corpus!.chunks) {
      const list = byStory.get(chunk.storyName) ?? []
      list.push(chunk)
      byStory.set(chunk.storyName, list)
    }
    let cursor = 0
    async function worker() {
      while (cursor < planState.rollouts.length) {
        if (args.limit && processed >= args.limit) return
        const rollout = planState.rollouts[cursor++]!
        try {
          await runRollout(ep, rollout, index, byStory, done, record)
        } catch (err) {
          console.warn(`  [rollout 失败] ${rollout.rolloutId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))
  }

  try {
    if (!args.noSeed) await seedWork()
    if (!args.noSynth) await synthWork()
  } finally {
    if (flushTimer) clearInterval(flushTimer)
    appendJsonl(SAMPLES_FILE, counters.samplesOut.splice(0))
    appendJsonl(REJECTED_FILE, counters.rejectedOut.splice(0))
  }

  console.log(
    `run 完成: 本轮处理 ${processed}（通过 ${accepted} / 拒绝 ${rejected}），累计样本 ${readJsonl<DistillSample>(SAMPLES_FILE).length}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`,
  )
}

/** 一个 rollout 的完整推进：opening → 各回合（Phase A → Phase B → 过滤 → 状态演化/回滚）。 */
async function runRollout(
  ep: EvalEndpoint,
  rollout: RolloutPlan & { split: 'train' | 'heldout' },
  ragIndex: LexicalIndex,
  byStory: Map<string, CorpusChunk[]>,
  done: Set<string>,
  record: (result: { sample: DistillSample | null; rejected: RejectedRow | null }) => void,
): Promise<void> {
  const state = initRolloutState(rollout)
  const storyChunks = byStory.get(rollout.storyName) ?? []
  const turnTypes: TurnType[] = ['opening', ...rollout.turns]
  let turnIndex = 0
  for (const turnType of turnTypes) {
    turnIndex++
    const skeletonId = `${rollout.rolloutId}#${turnIndex}`
    if (done.has(skeletonId)) {
      // 断点续跑：状态无法从 JSONL 完整重建（角色卡变更/场景演化），该 rollout 后续
      // 回合依赖的中间状态丢失——遇已处理回合即整场跳过（进度以整场为单位续跑）。
      return
    }
    const snapshot = snapshotState(state)
    try {
      let phaseAUsage: { promptTokens: number; completionTokens: number; calls: number } | null = null
      let batch = null
      if (turnType !== 'opening') {
        const synth = await synthesizeBatch({ ep, state, turnType, storyChunks })
        batch = synth.batch
        phaseAUsage = synth.usage
        appendUsage(synth.usage)
      }
      const skeleton = buildSkeleton({ rolloutId: rollout.rolloutId, state, turnIndex, turnType, batch, ragIndex })
      const turn = await replaySkeleton(ep, skeleton)
      const result = settleTurn(turn, 'synthetic', ep.model)
      record(result)
      if (result.sample) {
        applyTurnOutcome(
          state,
          {
            batchContent: skeleton.batchContent,
            batchPlayers: skeleton.batchPlayers,
            finalContent: turn.finalContent,
            worldDeltas: turn.worldDeltas,
          },
          () => `distill_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        )
      } else {
        restoreState(state, snapshot)
      }
      if (turn.worldDeltas.ending) return // end_game 收束，rollout 自然结束
    } catch (err) {
      restoreState(state, snapshot)
      throw err
    }
  }
}

async function stageAnchors(args: CliArgs): Promise<void> {
  ensureOutDir()
  const ep = teacherEndpointFromEnv()
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 }
  const golden = await buildGoldenAnchors({ ep, limit: args.limit || undefined, teacher: ep.model, usage })
  const mockSeeds = buildMockAnchorSeeds(loadDemoStoryText())
  const mockOut: DistillSample[] = []
  const mockRejected: RejectedRow[] = []
  for (const seed of mockSeeds) {
    try {
      const turn = await replaySkeleton(ep, mockAnchorSkeleton(seed))
      const result = settleTurn(turn, 'anchor', ep.model)
      if (result.sample) {
        result.sample.meta.id = seed.id
        result.sample.meta.origin = seed.id
        mockOut.push(result.sample)
      } else if (result.rejected) {
        mockRejected.push(result.rejected)
      }
    } catch (err) {
      console.warn(`  [mock 锚失败] ${seed.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const all = [...golden.samples, ...mockOut]
  fs.writeFileSync(ANCHORS_FILE, all.map((s) => JSON.stringify(s)).join('\n') + (all.length ? '\n' : ''), 'utf-8')
  appendJsonl(REJECTED_FILE, [
    ...golden.rejected.map((r) => ({ skeletonId: `anchor:golden:${r.id}`, turnType: 'anchor', source: 'anchor', category: r.category, detail: r.detail, usage: r.usage })),
    ...mockRejected,
  ])
  console.log(
    `锚样本完成: 金样本裁定通过 ${golden.samples.length}/${golden.judged}（拒绝 ${golden.rejected.length}，错误 ${golden.errors.length}）+ mock/e2e 锚 ${mockOut.length}/${mockSeeds.length} → ${ANCHORS_FILE}`,
  )
  for (const e of golden.errors) console.warn(`  [错误] ${e}`)
  for (const r of mockRejected) console.warn(`  [mock 锚拒绝] ${r.skeletonId}: ${r.category} ${r.detail}`)
}

async function stagePack(): Promise<void> {
  const plan: PlanState = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8'))
  const samples = readJsonl<DistillSample>(SAMPLES_FILE)
  const anchors = readJsonl<DistillSample>(ANCHORS_FILE)
  // 人工示范（可选）：用户把样本放入 training/data/human-samples.jsonl 即并入训练侧
  const human = fs.existsSync(HUMAN_FILE) ? readJsonl<DistillSample>(HUMAN_FILE) : []
  const rejectedRows = readJsonl<RejectedRow>(REJECTED_FILE)
  const heldoutProvenance = new Set<string>([
    ...plan.rollouts.filter((r) => r.split === 'heldout').map((r) => r.rolloutId),
    ...plan.heldoutSeedProvenance,
  ])
  const result = packSplit({ core: [...samples, ...human], anchors, heldoutProvenance })
  if (result.conflicts.length) throw new Error(`切分出处冲突（实现 bug）: ${result.conflicts.join(', ')}`)

  fs.writeFileSync(TRAIN_FILE, result.train.map((s) => JSON.stringify(s)).join('\n') + (result.train.length ? '\n' : ''), 'utf-8')
  fs.writeFileSync(HELDOUT_FILE, result.heldout.map((s) => JSON.stringify(s)).join('\n') + (result.heldout.length ? '\n' : ''), 'utf-8')
  fs.writeFileSync(ANCHORS_FILE, result.anchors.map((s) => JSON.stringify(s)).join('\n') + (result.anchors.length ? '\n' : ''), 'utf-8')

  const trainStats = computeStats(result.train)
  const heldoutStats = computeStats(result.heldout)
  const anchorStats = computeStats(result.anchors)
  const all = [...result.train, ...result.heldout, ...result.anchors]
  const filterStats = rejectedRows.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + 1
    return acc
  }, {})

  // 教师总成本 = 已收样本 + 被拒回合 + Phase A 台账（拒绝/合成阶段的调用也花钱）
  const ledger = readJsonl<{ promptTokens: number; completionTokens: number; calls: number }>(USAGE_LEDGER_FILE)
  const sumUsage = (usages: { promptTokens: number; completionTokens: number; calls: number }[]) =>
    usages.reduce((acc, u) => ({ promptTokens: acc.promptTokens + u.promptTokens, completionTokens: acc.completionTokens + u.completionTokens, calls: acc.calls + u.calls }), { promptTokens: 0, completionTokens: 0, calls: 0 })
  const fromSamples = sumUsage(all.map((s) => s.meta.usage))
  const fromRejected = sumUsage(rejectedRows.map((r) => r.usage))
  const fromLedger = sumUsage(ledger)

  if (trainStats.multiStep + heldoutStats.multiStep < 500) {
    console.warn(`[警告] 多步工具链 ${trainStats.multiStep + heldoutStats.multiStep} < 500——继续补跑 rollouts 后重新 pack`)
  }
  // 教师分桶（教师切换后新旧数据成本/配比可追溯；无 teacher 字段 = 初版教师）
  const DEFAULT_TEACHER = 'deepseek/deepseek-v4-flash'
  const teacherOf = (row: { teacher?: string }): string => row.teacher ?? DEFAULT_TEACHER
  const teacherBreakdown: Record<string, { accepted: number; multiStep: number; rejected: Record<string, number> }> = {}
  for (const s of all) {
    const t = teacherOf(s.meta as { teacher?: string })
    teacherBreakdown[t] ??= { accepted: 0, multiStep: 0, rejected: {} }
    teacherBreakdown[t]!.accepted++
    if (s.meta.multiStep) teacherBreakdown[t]!.multiStep++
  }
  for (const r of rejectedRows) {
    const t = teacherOf(r)
    teacherBreakdown[t] ??= { accepted: 0, multiStep: 0, rejected: {} }
    teacherBreakdown[t]!.rejected[r.category] = (teacherBreakdown[t]!.rejected[r.category] ?? 0) + 1
  }
  const datacard = {
    generatedAt: new Date().toISOString(),
    plan: { seed: plan.seed, rollouts: plan.rollouts.length, seedSkeletons: plan.seedSkeletonIds.length },
    train: trainStats,
    heldout: heldoutStats,
    anchors: anchorStats,
    human: { count: human.length, note: 'training/data/human-samples.jsonl 提供时并入训练侧；当前无则记 0' },
    filter: filterStats,
    toolAppearance: toolAppearance(all),
    zeroOverlap: {
      provenanceLevel: 'rollout/房间级整体归属 + seed 房间/存档级整体归属',
      contentLevel: 'contextHash(sha256) 跨侧去重',
      anchorNote: 'anchors.jsonl 独立文件；金样本锚 context 与 #42 gate 评测集同源（数据卡披露），held-out 不含锚样本',
    },
    teacher: {
      model: process.env.KP_DISTILL_MODEL ?? 'deepseek/deepseek-v4-flash',
      breakdown: teacherBreakdown,
      totalPromptTokens: fromSamples.promptTokens + fromRejected.promptTokens + fromLedger.promptTokens,
      totalCompletionTokens: fromSamples.completionTokens + fromRejected.completionTokens + fromLedger.completionTokens,
      totalCalls: fromSamples.calls + fromRejected.calls + fromLedger.calls,
      costBreakdown: { acceptedSamples: fromSamples, rejectedTurns: fromRejected, phaseALedger: fromLedger },
    },
  }
  fs.writeFileSync(DATACARD_FILE, JSON.stringify(datacard, null, 2), 'utf-8')
  console.log(
    `打包完成: train ${result.train.length}（多步 ${trainStats.multiStep}）/ held-out ${result.heldout.length} / anchors ${result.anchors.length}，去重丢弃 ${result.droppedDuplicate} → ${TRAIN_FILE}`,
  )
  console.log(`  教师调用: ${datacard.teacher.totalCalls} 次 / prompt ${datacard.teacher.totalPromptTokens} tok / completion ${datacard.teacher.totalCompletionTokens} tok`)
}

async function stageAudit(): Promise<void> {
  // 抽检条数为模块常量（零 argv→写内容流；需调整时改此处重跑 audit）
  const auditTarget = 60
  const train = readJsonl<DistillSample>(TRAIN_FILE)
  const heldout = readJsonl<DistillSample>(HELDOUT_FILE)
  const anchors = readJsonl<DistillSample>(ANCHORS_FILE)
  const selected = stratifyAudit([...train, ...heldout, ...anchors], auditTarget)
  const pack = buildAuditPack(selected)
  const auditRoot = path.join(OUT_DIR, 'audit')
  fs.mkdirSync(auditRoot, { recursive: true })
  fs.writeFileSync(path.join(auditRoot, 'manifest.json'), JSON.stringify(pack.manifest, null, 2), 'utf-8')
  fs.writeFileSync(path.join(auditRoot, 'checklist.md'), pack.checklistMarkdown, 'utf-8')
  fs.writeFileSync(path.join(auditRoot, 'data.js'), pack.dataJs, 'utf-8')
  // 查看器 = 仓库静态模板（training/data/audit-viewer.html）原样拷贝，管线不生成 HTML
  const viewerTemplate = path.join(REPO_ROOT, 'training', 'data', 'audit-viewer.html')
  fs.copyFileSync(viewerTemplate, path.join(auditRoot, 'viewer.html'))
  console.log(`抽检包完成: ${selected.length} 条 → ${auditRoot}/（checklist.md + viewer.html + data.js）`)
}

/* ── main ─────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.stage) {
    case 'corpus': return stageCorpus(args)
    case 'plan': return stagePlan(args)
    case 'run': return stageRun(args)
    case 'anchors': return stageAnchors(args)
    case 'pack': return stagePack()
    case 'audit': return stageAudit()
    default: throw new Error(`未知阶段: ${args.stage}\n${USAGE}`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
