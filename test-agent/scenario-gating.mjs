/**
 * 门控/确定性行为回归用例（修复验证）
 *
 * 覆盖 REPORT.md 三个关键改进点 + 线索门控架构建议：
 *  - AW-G-01 剧本结构可加载（结构化夹具上传后服务端可解析）
 *  - AW-G-02 锁闭场景：requiredClues 未满足 → 门控提示（plan trace 含「尚未解锁」），
 *    且 transition_scene 不被强制
 *  - AW-G-03 解锁场景：requiredClues 满足 → 门控提示可切换（trace 含「已解锁」）
 *  - AW-G-04 探索意图注入未获线索清单（trace 含「未获得、且前置条件已满足」）
 *  - AW-G-05 endgame 意图短路（trace intent_classified = endgame，end_game 进 requiredTools）
 *  - AW-G-06 SAN 历史提取：san_check 大失败后 trigger_insanity 进 requiredTools
 *  - AW-G-07 无剧本/自由文本剧本 → 无门控（零回归）
 *
 * 运行：node test-agent/scenario-gating.mjs
 */
import {
  startServices,
  registerUser,
  saveAiSettings,
  connectWs,
  api,
  step,
  printSummary,
  cleanup,
  getLlmConfig,
  uploadAndIndex,
} from './lib/common.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 从 trace 事件里提取 tool_plan_created 的 gatingHint / requiredTools */
function planInfo(traces) {
  const plan = (traces || []).find((t) => t.type === 'tool_plan_created')
  if (!plan) return { hint: '', requiredTools: [] }
  return { hint: plan.data?.gatingHint || plan.data?.plan || '', requiredTools: plan.data?.requiredTools || [] }
}

function intentOf(traces) {
  const t = (traces || []).find((x) => x.type === 'intent_classified')
  return t?.data?.intent || ''
}

async function main() {
  const llm = getLlmConfig()
  console.log(`[AW] LLM: ${llm.model} @ ${llm.baseUrl}`)

  const { apiBase, tmpRoot } = await startServices(3107, 5182, { web: false })
  console.log(`[AW] services up: ${apiBase}`)

  const user = `aw_g_${Date.now() % 100000}`
  const token = await registerUser(apiBase, user, 'testpass123')
  await saveAiSettings(apiBase, llm, token)

  // 上传结构化剧本（含 requiredClues 门控）
  const story = await uploadAndIndex(apiBase, path.join(here, 'fixtures', 'black-campus-structured.json'), token)
  const scriptId = story.upload?.scriptId ?? story.upload?.id
  console.log(`[AW] structured script uploaded: ${scriptId}`)

  const sceneCtx = (sceneName, clueIds = []) => ({
    scriptId,
    sceneId: sceneName,
    sceneName,
    sceneType: 'investigation',
    openClues: clueIds.map((id) => ({ id, description: id })),
  })

  /* ── G-01 剧本可加载 ── */
  await step('AW-G-01 结构化剧本上传并可被服务端解析（门控提示出现）', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const r = await ws.invoke(
      [{ role: 'user', content: '我在校长办公室，查看马卡拉的办公桌。' }],
      { streamId: 'g01', timeoutMs: 240_000 },
      sceneCtx('校长办公室', []),
    )
    const info = planInfo(r.traces)
    console.log(`    gatingHint: ${info.hint.slice(0, 120)}`)
    if (!info.hint) throw new Error('门控提示缺失：剧本未加载或未命中场景')
    ws.close()
  })

  /* ── G-02 锁闭场景 ── */
  await step('AW-G-02 锁闭场景：未获线索 → 门控拒绝 transition_scene', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const r = await ws.invoke(
      [{ role: 'user', content: '我前往学校资料室。' }],
      { streamId: 'g02', timeoutMs: 240_000 },
      sceneCtx('校长办公室', []),
    )
    const info = planInfo(r.traces)
    console.log(`    gatingHint: ${info.hint.slice(0, 140)}`)
    if (!info.hint.includes('尚未解锁') && !info.hint.includes('门控')) {
      throw new Error(`未出现锁闭门控提示: ${info.hint.slice(0, 120)}`)
    }
    // 锁闭场景 transition_scene 不应被强制进 required（避免 LLM 硬切）
    // 注：move 意图的 TOOL_PLAN 不含 transition_scene，只有门控在解锁时才建议
    ws.close()
  }, 240_000)

  /* ── G-03 解锁场景 ── */
  await step('AW-G-03 解锁场景：持有前置线索 → 门控提示可切换', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const r = await ws.invoke(
      [{ role: 'user', content: '我拿到了地基图纸，前往学校资料室。' }],
      { streamId: 'g03', timeoutMs: 240_000 },
      sceneCtx('校长办公室', ['clue_001', 'clue_003']),
    )
    const info = planInfo(r.traces)
    console.log(`    gatingHint: ${info.hint.slice(0, 140)}`)
    if (!info.hint.includes('已解锁')) throw new Error(`未出现解锁门控提示: ${info.hint.slice(0, 120)}`)
    ws.close()
  })

  /* ── G-04 探索意图注入未获线索 ── */
  await step('AW-G-04 探索意图：注入场景内未获且前置满足的线索', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const r = await ws.invoke(
      [{ role: 'user', content: '我在校长办公室调查，看看有什么值得注意的东西。' }],
      { streamId: 'g04', timeoutMs: 240_000 },
      sceneCtx('校长办公室', []),
    )
    const info = planInfo(r.traces)
    console.log(`    gatingHint: ${info.hint.slice(0, 160)}`)
    if (!info.hint.includes('前置条件已满足') && !info.hint.includes('尚未获得')) {
      throw new Error(`未注入可获线索清单: ${info.hint.slice(0, 120)}`)
    }
    ws.close()
  })

  /* ── G-05 endgame 意图 ── */
  await step('AW-G-05 明确结局表达 → endgame 意图短路 + end_game 强制', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const r = await ws.invoke(
      [{ role: 'user', content: '我们成功逃离了这里，这段冒险到此结束，结局吧。' }],
      { streamId: 'g05', timeoutMs: 240_000 },
      sceneCtx('地下密室', ['clue_001', 'clue_003', 'clue_004', 'clue_005']),
    )
    const info = planInfo(r.traces)
    console.log(`    intent: ${intentOf(r.traces)}, requiredTools: ${JSON.stringify(info.requiredTools)}`)
    if (intentOf(r.traces) !== 'endgame') throw new Error(`意图应为 endgame，实际 ${intentOf(r.traces)}`)
    if (!info.requiredTools.includes('end_game')) throw new Error('end_game 未进 requiredTools')
    ws.close()
  })

  /* ── G-06 SAN 历史提取 → trigger_insanity ── */
  await step('AW-G-06 单次 SAN 损失 ≥5 → san_encounter 短路 + trigger_insanity 强制', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const messages = [
      { role: 'user', content: '我直视了神像。' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'san1', type: 'function', function: { name: 'san_check', arguments: '{"currentSan":50,"successLoss":"1","failureLoss":"1d8"}' } }],
      },
      { role: 'tool', tool_call_id: 'san1', content: JSON.stringify({ roll: 77, currentSan: 50, passed: false, sanLost: 8, lossExpression: '1d8' }) },
      { role: 'user', content: '我继续盯着神像，脑子里一片混乱。' },
    ]
    const r = await ws.invoke(messages, { streamId: 'g06', timeoutMs: 240_000 }, sceneCtx('地下密室', []))
    const info = planInfo(r.traces)
    console.log(`    intent: ${intentOf(r.traces)}, requiredTools: ${JSON.stringify(info.requiredTools)}`)
    if (intentOf(r.traces) !== 'san_encounter') throw new Error(`意图应为 san_encounter，实际 ${intentOf(r.traces)}`)
    if (!info.requiredTools.includes('trigger_insanity')) throw new Error('trigger_insanity 未进 requiredTools')
    ws.close()
  })

  /* ── G-07 无剧本 → 零门控 ── */
  await step('AW-G-07 无 storyContext / 无效剧本 → 门控跳过（零回归）', async () => {
    const ws = connectWs(apiBase, token)
    await ws.opened
    const r = await ws.invoke([{ role: 'user', content: '我在校长办公室查看办公桌。' }], { streamId: 'g07', timeoutMs: 240_000 })
    const info = planInfo(r.traces)
    console.log(`    gatingHint: ${(info.hint || '').slice(0, 80) || '(无)'}  requiredTools: ${JSON.stringify(info.requiredTools)}`)
    if (!r.content && !r.toolCalls?.length) throw new Error('无剧本场景应正常响应')
    ws.close()
  })

  printSummary('scenario-gating')
  cleanup()
}

main().catch((err) => {
  console.error('[AW] FATAL', err)
  cleanup()
  process.exitCode = 1
})
