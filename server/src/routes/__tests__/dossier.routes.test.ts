/**
 * Dossier routes integration spec — POST /api/dossier/:scriptId/generate +
 * GET /api/dossier list + auth, hitting the real app (supertest) with a mocked
 * dossier service (deterministic generation, no LLM).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import request from 'supertest'
import { TEST_PASSWORD } from '../../testHelpers.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dossier-routes-'))
vi.stubEnv('DATA_DIR', path.join(tmp, 'data'))
vi.stubEnv('UPLOADS_DIR', path.join(tmp, 'uploads'))
vi.stubEnv('RAG_DATA_DIR', path.join(tmp, 'rag'))
vi.stubEnv('DOSSIER_DATA_DIR', path.join(tmp, 'dossiers'))
vi.stubEnv('JWT_SECRET', 'test-secret-dossier')
vi.stubEnv('MOCK_AI', '1')

vi.resetModules()

// Mock the dossier service so generate returns deterministically without LLM.
const generateMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())

vi.mock('../../rag/dossier/storyDossierService.js', () => ({
  generateDossier: generateMock,
  loadDossier: vi.fn(),
  listDossiers: listMock,
  deleteDossier: vi.fn(),
}))

const { createApp } = await import('../../app.js')

let seq = 0

async function registerToken(username: string): Promise<string> {
  const res = await request(createApp()).post('/api/auth/register').send({ username: `${username}_${Date.now()}_${seq++}`, password: TEST_PASSWORD })
  return (res.body as { token?: string }).token ?? ''
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('dossier routes', () => {
  it('requires auth', async () => {
    const res = await request(createApp()).get('/api/dossier')
    expect(res.status).toBe(401)
  })

  it('generate → list lifecycle', async () => {
    const token = await registerToken('dossier_lc')

    generateMock.mockResolvedValueOnce({ ok: true, scriptId: 'demo.txt', scenes: 3, clues: 3, npcs: 2 })
    const gen = await request(createApp()).post('/api/dossier/demo.txt/generate').set(auth(token)).send({})
    expect(gen.status).toBe(200)
    expect(gen.body).toMatchObject({ ok: true, scenes: 3, clues: 3, npcs: 2 })

    listMock.mockResolvedValueOnce([{ scriptId: 'demo.txt', name: '旧图书馆的铜钥匙', sceneCount: 3, generatedAt: 1 }])
    const list = await request(createApp()).get('/api/dossier').set(auth(token))
    expect(list.body).toHaveLength(1)
    expect(list.body[0].sceneCount).toBe(3)
  })

  it('rejects traversal scriptIds (400 from assertSafeId or 404 from routing)', async () => {
    const token = await registerToken('dossier_trav')
    const res = await request(createApp()).post('/api/dossier/..%2F..%2Fetc%2Fpasswd/generate').set(auth(token)).send({})
    // 路径穿越必须被拒：要么 assertSafeId 400，要么 express 路由层 404——两者都证明不可达
    expect([400, 404]).toContain(res.status)
  })
})
