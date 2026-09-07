/**
 * Dossier routes integration spec — POST/GET/DELETE/GET /api/dossier*
 * lifecycle + auth + user isolation, hitting the real app (supertest) with a
 * mocked dossier service (deterministic generation, no LLM).
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
const loadMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const deleteMock = vi.hoisted(() => vi.fn())

vi.mock('../../rag/dossier/storyDossierService.js', () => ({
  generateDossier: generateMock,
  loadDossier: loadMock,
  listDossiers: listMock,
  deleteDossier: deleteMock,
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

  it('lifecycle: generate → read → list → delete', async () => {
    const token = await registerToken('dossier_lc')

    generateMock.mockResolvedValueOnce({ ok: true, scriptId: 'demo.txt', scenes: 3, clues: 3, npcs: 2 })
    const gen = await request(createApp()).post('/api/dossier/demo.txt/generate').set(auth(token)).send({})
    expect(gen.status).toBe(200)
    expect(gen.body).toMatchObject({ ok: true, scenes: 3, clues: 3, npcs: 2 })

    loadMock.mockResolvedValueOnce({
      scriptId: 'demo.txt',
      storyName: '旧图书馆的铜钥匙',
      generatedAt: 1,
      scenes: [{ id: 'scene_1', name: '旧图书馆', description: '图书馆' }],
      clues: [{ id: 'c1' }],
      npcs: [{ id: 'n1' }],
    })
    const read = await request(createApp()).get('/api/dossier/demo.txt').set(auth(token))
    expect(read.status).toBe(200)
    expect(read.body.storyName).toBe('旧图书馆的铜钥匙')
    expect(read.body.scenes).toHaveLength(1)

    listMock.mockResolvedValueOnce([{ scriptId: 'demo.txt', name: '旧图书馆的铜钥匙', sceneCount: 3, generatedAt: 1 }])
    const list = await request(createApp()).get('/api/dossier').set(auth(token))
    expect(list.body).toHaveLength(1)

    deleteMock.mockResolvedValueOnce(true)
    const del = await request(createApp()).delete('/api/dossier/demo.txt').set(auth(token))
    expect(del.body).toEqual({ ok: true })
  })

  it('returns null for a missing dossier (no 404 crash)', async () => {
    const token = await registerToken('dossier_miss')
    loadMock.mockResolvedValueOnce(null)
    const res = await request(createApp()).get('/api/dossier/demo.txt').set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
  })
})
