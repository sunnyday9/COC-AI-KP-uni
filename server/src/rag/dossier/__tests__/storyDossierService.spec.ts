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

const { generateDossier, loadDossier, listDossiers, deleteDossier, buildSceneBlock, findScene, lexicalSearch, splitStorySections, stripCodeFence } = await import('../storyDossierService.js')
const { importStory, readStory } = await import('../../../services/storyService.js')

// chatForRag mock: return a small deterministic dossier per batch.
vi.mock('../../../services/aiService.js', () => ({
  chatForRag: vi.fn(async () => ({
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
  })),
}))

describe('storyDossierService', () => {
  let userId = 1

  beforeEach(async () => {
    userId = 1
    await fs.mkdir(path.join(tmpUploads, String(userId), 'stories'), { recursive: true })
  })

  afterEach(async () => {
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
})
