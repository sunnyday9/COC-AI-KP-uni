/**
 * storyDossierService spec — generation (mocked chatForRag), persistence,
 * lookups (scene block / lexical search). Runs against a temp DOSSIER_DATA_DIR
 * and a temp uploads dir; chatForRag is vi.mock'd to return deterministic
 * dossier JSON per call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dossier-spec-'))
const tmpUploads = path.join(tmpRoot, 'uploads')
const tmpDossier = path.join(tmpRoot, 'dossiers')

vi.stubEnv('UPLOADS_DIR', tmpUploads)
vi.stubEnv('DOSSIER_DATA_DIR', tmpDossier)

// Story + dossier service modules import config at module load; reset between
// files so the env above takes effect.
vi.resetModules()

const { generateDossier, loadDossier, listDossiers, deleteDossier, buildSceneBlock, coverageHintLine, VERIFY_ORIGINAL_HINT, renderSceneNotFound, renderSceneUncovered, renderLexicalMiss, findScene, lexicalSearch, splitStorySections, stripCodeFence, persist, dossierGateNotice } = await import('../storyDossierService.js')
const { importStory, readStory } = await import('../../../services/storyService.js')
const { persistGaps, GAPS_VERSION } = await import('../coverageGaps.js')
const { chatForRag } = await import('../../../services/aiService.js')

// chatForRag mock: return a small deterministic dossier per batch.
// 默认实现抽成 hoisted 常量，#55 的重试用例可用 mockImplementationOnce 叠加失败轮次，
// afterEach 恢复默认，互不污染。
const goodChatImpl = vi.hoisted(() => async () => ({
  content: JSON.stringify({
    scenes: [
      {
        id: 'scene_1',
        name: '旧图书馆',
        sceneText: '旧图书馆常年笼罩在灰尘与霉味之中。书架角落放着一只青瓷花瓶。',
        description: '图书馆',
        clueIds: ['clue_1'],
      },
    ],
    clues: [{ id: 'clue_1', description: '青瓷花瓶是空心的，底部有夹层。', location: 'scene_1' }],
    npcs: [{ id: 'npc_1', name: '阿洛伊斯', role: '管理员', description: '谨慎' }],
  }),
}))

vi.mock('../../../services/aiService.js', () => ({
  chatForRag: vi.fn(goodChatImpl),
}))

describe('storyDossierService', () => {
  let userId = 1
  const chatMock = vi.mocked(chatForRag)

  beforeEach(async () => {
    userId = 1
    await fs.mkdir(path.join(tmpUploads, String(userId), 'stories'), { recursive: true })
  })

  afterEach(async () => {
    // mockReset 清掉 Once 队列与自定义实现；随后显式恢复默认好 JSON——
    // 未耗尽的 Once 若泄漏进下一用例会静默改变其 mock 行为
    chatMock.mockReset()
    chatMock.mockImplementation(goodChatImpl)
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('splitStorySections splits long text at paragraph gaps', () => {
    const text = Array.from({ length: 30 }, (_, i) => `第${i}段：${'字'.repeat(600)}`).join('\n\n')
    const sections = splitStorySections(text, 2000)
    expect(sections.length).toBeGreaterThan(1)
    // each section ≤ batch size + remainder
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(2200)
  })

  it('stripCodeFence removes json fences', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}')
  })

  it('generates a dossier from an uploaded story via mocked LLM and persists it', async () => {
    // upload a demo story
    const up = await importStory(userId, {
      originalname: 'demo.txt',
      buffer: Buffer.from('# 测试故事\n\n## 场景一：旧图书馆\n\n书架角落放着一只青瓷花瓶。'),
      size: 100,
    })
    expect(up.ok).toBe(true)
    const scriptId = up.id as string

    const res = await generateDossier(userId, scriptId)
    expect(res.ok).toBe(true)
    expect(res.scenes).toBe(1)
    expect(res.clues).toBe(1)
    expect(res.npcs).toBe(1)

    // persisted + loadable
    const loaded = await loadDossier(userId, scriptId)
    expect(loaded).not.toBeNull()
    expect(loaded?.scenes[0]?.name).toBe('旧图书馆')

    const list = await listDossiers(userId)
    expect(list.length).toBe(1)
    expect(list[0]?.scriptId).toBe(scriptId)

    await deleteDossier(userId, scriptId)
    expect(await loadDossier(userId, scriptId)).toBeNull()
  })

  it('findScene matches by name, id and substring (longest wins)', async () => {
    const dossier = {
      scriptId: 's', storyName: 's', generatedAt: 0,
      scenes: [
        { id: 'a', name: '地下室', sceneText: '' },
        { id: 'b', name: '旧图书馆', sceneText: '' },
      ],
      clues: [], npcs: [],
    }
    expect(findScene(dossier as never, '地下室')?.id).toBe('a')
    expect(findScene(dossier as never, 'b')?.name).toBe('旧图书馆')
    expect(findScene(dossier as never, '我要去旧图书馆看看')?.id).toBe('b')
    expect(findScene(dossier as never, '档案馆')).toBeNull()
  })

  it('buildSceneBlock renders scene text + npcs + clues', async () => {
    const dossier = {
      scriptId: 's', storyName: 's', generatedAt: 0,
      scenes: [
        {
          id: 'scene_1', name: '旧图书馆',
          sceneText: '灰尘与霉味。', description: '图书馆',
          npcIds: ['npc_1'], clueIds: ['clue_1'],
          hooks: ['检查花瓶'],
        },
      ],
      clues: [{ id: 'clue_1', description: '青瓷花瓶是空心的。', requiredClues: [] }],
      npcs: [{ id: 'npc_1', name: '阿洛伊斯', role: '管理员', description: '谨慎' }],
    }
    const block = buildSceneBlock(dossier as never, '旧图书馆')
    expect(block).toContain('灰尘与霉味')
    expect(block).toContain('阿洛伊斯')
    expect(block).toContain('青瓷花瓶是空心的')
    expect(buildSceneBlock(dossier as never, '不存在')).toBe('')
  })

  it('buildSceneBlock 带覆盖提示（P26）：覆盖不足时提示可用 verify_original 查原文', async () => {
    const dossier = {
      scriptId: 's', storyName: 's', generatedAt: 0,
      scenes: [{ id: 'scene_1', name: '旧图书馆', sceneText: '灰尘与霉味。', description: '' }],
      clues: [], npcs: [],
    }
    const cov = { sceneId: 'scene_1', sceneName: '旧图书馆', regionChars: 3_000, gapChars: 1_100, coveragePct: 63.3, gapCount: 3 }
    const block = buildSceneBlock(dossier as never, '旧图书馆', cov)
    expect(block).toContain('63.3')
    expect(block).toContain('3')
    expect(block).toContain(VERIFY_ORIGINAL_HINT)
    // 不传覆盖度 / 覆盖完整 → 不出现提示行（保持既有块形态）
    expect(buildSceneBlock(dossier as never, '旧图书馆')).not.toContain('verify_original')
    expect(buildSceneBlock(dossier as never, '旧图书馆', { ...cov, gapCount: 0, coveragePct: 100 })).not.toContain('verify_original')
    expect(coverageHintLine(null)).toBe('')
    expect(coverageHintLine({ ...cov, gapCount: 0, coveragePct: 100 })).toBe('')
    expect(coverageHintLine(cov)).toContain(VERIFY_ORIGINAL_HINT)
  })

  it('档案查空时的提示（P26）：场景未命中 / 关键词零命中都指向 verify_original', async () => {
    const missScene = renderSceneNotFound('不存在的地方', ['旧图书馆', '钟楼'])
    expect(missScene).toContain('不存在的地方')
    expect(missScene).toContain('旧图书馆')
    expect(missScene).toContain(VERIFY_ORIGINAL_HINT)
    expect(missScene).toContain('verify_original')
    const missLex = renderLexicalMiss('关键词')
    expect(missLex).toContain('关键词')
    expect(missLex).toContain(VERIFY_ORIGINAL_HINT)
    // 单源：两条文案共用同一句引导（改一处即同步）
    expect(missScene.indexOf(VERIFY_ORIGINAL_HINT)).toBeGreaterThan(0)
    expect(missLex.indexOf(VERIFY_ORIGINAL_HINT)).toBeGreaterThan(0)
  })

  it('#53：房间场景有值但档案没有 → renderSceneUncovered 指引改造场景，不冒充别的场景', async () => {
    const uncovered = renderSceneUncovered('废弃的地窖', ['旧图书馆', '钟楼'])
    // 点出房间声称的场景名（KP 要能意识到"对不上"），并列出档案里的场景清单
    expect(uncovered).toContain('废弃的地窖')
    expect(uncovered).toContain('旧图书馆')
    expect(uncovered).toContain('scene_list')
    // 首行标记：这段文本会落在 `## 当前场景档案` 标题下，必须自带"这不是当前场景档案"
    expect(uncovered.startsWith('【场景归属提示】')).toBe(true)
    // 出口：把场景名纠正到档案口径（transition_scene）+ 原文查证
    expect(uncovered).toContain('transition_scene')
    expect(uncovered).toContain(VERIFY_ORIGINAL_HINT)
    // 且**不含**任何别的场景的档案内容
    expect(uncovered).not.toContain('现场描述')
    // 空场景名 → 空串（调用方据此不注入）
    expect(renderSceneUncovered('', ['旧图书馆'])).toBe('')
    // 档案一个场景都没有 → 兜底文案不崩
    expect(renderSceneUncovered('地窖', [])).toContain('（无）')
  })

  it('lexicalSearch finds scenes/clues/npcs by term overlap', async () => {
    const dossier = {
      scriptId: 's', storyName: 's', generatedAt: 0,
      scenes: [{ id: 'a', name: '地下室', sceneText: '门后传来水滴声与低语', description: '', keywords: [] }],
      clues: [{ id: 'c1', description: '铜钥匙藏在地板下', location: '', requiredClues: [] }],
      npcs: [{ id: 'n1', name: '阿洛伊斯', role: '管理员', description: '' }],
    }
    const hits = lexicalSearch(dossier as never, '地下室 低语', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.kind).toBe('scene')
    const clueHits = lexicalSearch(dossier as never, '铜钥匙')
    expect(clueHits.some((h) => h.kind === 'clue')).toBe(true)
    const npcHits = lexicalSearch(dossier as never, '管理员')
    expect(npcHits.some((h) => h.kind === 'npc')).toBe(true)
  })

  it('does not write outside the user dossier dir (traversal guard)', async () => {
    await expect(generateDossier(userId, '../evil')).resolves.toMatchObject({ ok: false })
  })

  // ═══════ #55 生成期：分节解析失败重试加固 ═══════

  it('#55：单节 chatForRag 抛错（上游 400/503）→ 同节重试后成功，该节照常收录', async () => {
    chatMock.mockImplementationOnce(async () => { throw new Error('upstream 503') })
    const up = await importStory(userId, {
      originalname: 'retry-throw.txt',
      buffer: Buffer.from('# 测试故事\n\n书架角落放着一只青瓷花瓶。'),
      size: 40,
    })
    const res = await generateDossier(userId, up.id as string)
    expect(res.ok).toBe(true)
    expect(res.scenes).toBe(1)
    expect(chatMock.mock.calls).toHaveLength(2)
  })

  it('#55：解析失败重试抬 max_tokens——第 1-2 次 16384，第 3 次起 32768（推理模型截断不因重发自愈）', async () => {
    chatMock.mockImplementationOnce(async () => ({ content: '{"scenes": [' }))
    chatMock.mockImplementationOnce(async () => ({ content: '抱歉，我无法输出' }))
    const up = await importStory(userId, {
      originalname: 'retry-escalate.txt',
      buffer: Buffer.from('# 测试故事\n\n书架角落放着一只青瓷花瓶。'),
      size: 40,
    })
    const res = await generateDossier(userId, up.id as string)
    expect(res.ok).toBe(true)
    const calls = chatMock.mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0]?.[1]?.maxTokens).toBe(16384)
    expect(calls[1]?.[1]?.maxTokens).toBe(16384)
    expect(calls[2]?.[1]?.maxTokens).toBe(32768)
  })

  it('#55：重试耗尽仍失败 → 单节故事 ok:false（不再静默产出空档案）', async () => {
    chatMock.mockImplementation(async () => { throw new Error('upstream down') })
    const up = await importStory(userId, {
      originalname: 'retry-dead.txt',
      buffer: Buffer.from('# 测试故事\n\n书架角落放着一只青瓷花瓶。'),
      size: 40,
    })
    const res = await generateDossier(userId, up.id as string)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('batch 1/1')
    expect(chatMock.mock.calls).toHaveLength(4)
  })

  it('#55：多节故事部分节失败 → 降级为部分档案 + failedBatches/degraded 落盘', async () => {
    // ~12k 字符 → 2 节；第 1 节好 JSON，第 2 节恒抛
    const long = '# 长故事\n\n' + '码头上的雾很重，调查员抵达港口。'.repeat(800)
    let call = 0
    chatMock.mockImplementation(async () => {
      call++
      if (call <= 1) return goodChatImpl()
      throw new Error('upstream down')
    })
    const up = await importStory(userId, { originalname: 'retry-partial.txt', buffer: Buffer.from(long), size: long.length })
    const res = await generateDossier(userId, up.id as string)
    expect(res.ok).toBe(true)
    expect(res.warnings?.some((w) => w.includes('1 个分节解析失败'))).toBe(true)
    expect(res.degraded).toBe(true)
    const loaded = await loadDossier(userId, up.id as string)
    expect(loaded?.quality?.degraded).toBe(true)
    expect(loaded?.quality?.failedBatches).toBe(1)
    expect(typeof loaded?.quality?.coveragePct).toBe('number')
  })

  it('#55：健康生成 → quality.degraded=false 随档案落盘，结果不标降质', async () => {
    const up = await importStory(userId, {
      originalname: 'healthy.txt',
      buffer: Buffer.from('# 测试故事\n\n书架角落放着一只青瓷花瓶。'),
      size: 40,
    })
    const res = await generateDossier(userId, up.id as string)
    expect(res.ok).toBe(true)
    expect(res.degraded).toBe(false)
    const loaded = await loadDossier(userId, up.id as string)
    expect(loaded?.quality?.degraded).toBe(false)
  })

  // ═══════ #55 产物期：dossierGateNotice（门闩判定单源，纯函数） ═══════

  it('#55：清单带 degraded 快照 → dossierGateNotice 提示；健康 → null；缺档案 → null', async () => {
    const ok = await importStory(userId, {
      originalname: 'notice-ok.txt',
      buffer: Buffer.from('# 测试故事\n\n书架角落放着一只青瓷花瓶。'),
      size: 40,
    })
    await generateDossier(userId, ok.id as string)
    const okList = await listDossiers(userId)
    expect(dossierGateNotice(okList, ok.id as string)).toBeNull()

    const bad = await importStory(userId, {
      originalname: 'notice-bad.txt',
      buffer: Buffer.from('# 测试故事\n\n地下室传来低语。'),
      size: 40,
    })
    await persist(userId, {
      scriptId: bad.id as string,
      storyName: '残档',
      generatedAt: Date.now(),
      scenes: [{ id: 's1', name: '码头', sceneText: '雾' }],
      clues: [],
      npcs: [],
      quality: { coveragePct: 3, degraded: true, failedBatches: 3, at: Date.now() },
    })
    const notice = dossierGateNotice(await listDossiers(userId), bad.id as string)
    expect(notice).toContain('3%')
    expect(notice).toContain('3 个分节解析失败')
    expect(notice).toContain('重新生成')
    // 与「未生成档案」的 409 文案严格区分
    expect(notice).not.toContain('尚未生成档案')

    // 清单里没有该剧本（未生成）→ null（不是降质，由既有门闩分支提示）
    expect(dossierGateNotice(okList, 'no-such-story')).toBeNull()
  })

  it('#55：旧档案（无 quality 快照）→ 清单扫描读兄弟 .gaps.json 估算；v1/无明细则放行', async () => {
    const legacy = await importStory(userId, {
      originalname: 'notice-legacy.txt',
      buffer: Buffer.from('# 测试故事\n\n档案室堆满卷宗。'),
      size: 40,
    })
    await persist(userId, {
      scriptId: legacy.id as string,
      storyName: '旧档',
      generatedAt: Date.now(),
      scenes: [{ id: 's1', name: '码头', sceneText: '雾' }],
      clues: [],
      npcs: [],
    })
    await persistGaps(userId, {
      storyChars: 20_000,
      sceneTextChars: 2_000,
      gapCount: 4,
      gapChars: 18_000,
      gapPct: 90,
      spans: [],
      sceneAnchors: [],
      scriptId: legacy.id as string,
      storyName: '旧档',
      generatedAt: Date.now(),
      // 兜底估算只信当前算法版本：v1 文件 gapPct 系统性偏高，不据此判降质
      gapsVersion: GAPS_VERSION,
    })
    const legacyItem = (await listDossiers(userId)).find((d) => d.scriptId === legacy.id)
    expect(legacyItem?.degraded).toBe(true)
    expect(legacyItem?.coveragePct).toBe(10)
    const notice = dossierGateNotice([legacyItem!], legacy.id as string)
    expect(notice).toContain('10%')
    expect(notice).toContain('重新生成')

    // 无 gaps 明细的旧档案 → 无从判定，放行（不误伤既有档案）
    const bare = await importStory(userId, {
      originalname: 'notice-bare.txt',
      buffer: Buffer.from('# 测试故事\n\n钟楼敲响了午夜。'),
      size: 40,
    })
    await persist(userId, {
      scriptId: bare.id as string,
      storyName: '更旧档',
      generatedAt: Date.now(),
      scenes: [{ id: 's1', name: '码头', sceneText: '雾' }],
      clues: [],
      npcs: [],
    })
    const bareItem = (await listDossiers(userId)).find((d) => d.scriptId === bare.id)
    expect(bareItem?.degraded).toBeUndefined()
    expect(dossierGateNotice([bareItem!], bare.id as string)).toBeNull()
  })
})
