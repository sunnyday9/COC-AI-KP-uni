import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as proxyRequest, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPostgresPool } from '../db/postgres.js'
import { loadActivePreparedStory } from '../services/preparedStoryStorage.js'
import { makePdfWithTextAndEmbeddedImages } from '../../test/helpers/pdfFixture.js'

const databaseUrl = process.env.TEST_SHARED_STORIES_DATABASE_URL
const s3Fixture = process.env.TEST_SHARED_STORIES_S3
const fixtureObjectStore = JSON.parse(s3Fixture ?? '{}')
const fixtureEndpoint = URL.parse(fixtureObjectStore.endpoint ?? '')
const canInjectStorageFault = fixtureObjectStore.forcePathStyle === true
  && fixtureEndpoint?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(fixtureEndpoint.hostname)
const secret = randomBytes(32).toString('hex')
const password = randomBytes(15).toString('hex')
const children: ChildProcess[] = []
let storageDir: string
let first: string
let second: string

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('could not reserve a port'))
        else resolve(address.port)
      })
    })
  })
}

function startProcess(entry: string, dir: string, endpointOverride?: string, prepare = false, port?: number): ChildProcess {
  const objectStore = JSON.parse(s3Fixture!)
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      TEST_SHARED_STORIES_DATABASE_URL: undefined,
      TEST_SHARED_STORIES_S3: undefined,
      DEPLOYMENT_MODE: 'shared-accounts',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: secret,
      NODE_ENV: 'production',
      STORY_PREPARATION_ENABLED: prepare ? '1' : '0',
      PORT: port === undefined ? undefined : String(port),
      MOCK_AI: '1',
      STORY_PREPARATION_LEASE_MS: '3000',
      DATA_DIR: join(storageDir, dir, 'data'),
      UPLOADS_DIR: join(storageDir, dir, 'uploads'),
      MAX_UPLOAD_BYTES: String(1024 * 1024),
      STORY_S3_BUCKET: objectStore.bucket,
      STORY_S3_REGION: objectStore.region,
      STORY_S3_ENDPOINT: endpointOverride ?? objectStore.endpoint,
      STORY_S3_FORCE_PATH_STYLE: objectStore.forcePathStyle === undefined ? undefined : String(objectStore.forcePathStyle),
      AWS_ACCESS_KEY_ID: objectStore.credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: objectStore.credentials.secretAccessKey,
      AWS_SESSION_TOKEN: undefined,
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  children.push(child)
  return child
}

async function stopProcess(child: ChildProcess, signal?: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill(signal)
  })
}

async function startGateway(port: number, dir: string, endpointOverride?: string, prepare = false): Promise<string> {
  const child = startProcess('src/app.ts', dir, endpointOverride, prepare, port)
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1_000) }).catch(() => null)
    if (response?.ok) return url
    await delay(100)
  }
  throw new Error('story gateway never became ready')
}

async function call(url: string, path: string, token?: string, method = 'GET', body?: BodyInit) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (typeof body === 'string') headers.set('Content-Type', 'application/json')
  const response = await fetch(`${url}${path}`, { method, headers, body, signal: AbortSignal.timeout(15_000) })
  return { status: response.status, body: await response.json() }
}

async function account(url: string) {
  const username = randomUUID().slice(0, 24)
  const response = await call(url, '/api/auth/register', undefined, 'POST', JSON.stringify({ username, password }))
  expect(response.status).toBe(200)
  return response.body as { token: string; user: { id: number } }
}

function upload(url: string, token: string, name: string, content: BlobPart) {
  const form = new FormData()
  form.append('file', new Blob([content]), name)
  return call(url, '/api/stories/upload', token, 'POST', form)
}

describe.skipIf(!databaseUrl || !s3Fixture)('private story catalog over two HTTP gateways', () => {
  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'aikp-shared-story-http-'))
    const { bucket, region, endpoint, forcePathStyle, credentials } = JSON.parse(s3Fixture!)
    vi.stubEnv('DATABASE_URL', databaseUrl)
    vi.stubEnv('STORY_S3_BUCKET', bucket)
    vi.stubEnv('STORY_S3_REGION', region)
    vi.stubEnv('STORY_S3_ENDPOINT', endpoint)
    vi.stubEnv('STORY_S3_FORCE_PATH_STYLE', forcePathStyle === undefined ? undefined : String(forcePathStyle))
    vi.stubEnv('AWS_ACCESS_KEY_ID', credentials.accessKeyId)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', credentials.secretAccessKey)
    vi.stubEnv('AWS_SESSION_TOKEN', undefined)
    const firstPort = await freePort()
    const secondPort = await freePort()
    const gateways = await Promise.all([startGateway(firstPort, 'first'), startGateway(secondPort, 'second')])
    first = gateways[0]
    second = gateways[1]
  }, 25_000)

  afterAll(async () => {
    await Promise.all(children.map((child) => stopProcess(child)))
    await getPostgresPool().end()
    vi.unstubAllEnvs()
    if (storageDir) await rm(storageDir, { recursive: true, force: true })
  })

  it('uploads through one gateway and reads, lists and deletes through the other', async () => {
    const owner = await account(first)
    const other = await account(second)
    expect(await upload(first, owner.token, '雾中的灯塔.txt', '虚构调查原文')).toEqual({
      status: 200, body: { ok: true, id: '雾中的灯塔.txt', name: '雾中的灯塔.txt' },
    })
    const storyUrl = '/api/stories/' + encodeURIComponent('雾中的灯塔.txt')
    expect(await call(second, storyUrl, owner.token)).toEqual({
      status: 200, body: { name: '雾中的灯塔.txt', content: '虚构调查原文' },
    })
    expect(await call(second, '/api/stories', owner.token)).toEqual({
      status: 200, body: [{ id: '雾中的灯塔.txt', name: '雾中的灯塔.txt' }],
    })
    const source = await fetch(second + storyUrl + '/source', { headers: { Authorization: `Bearer ${owner.token}` } })
    expect(source.status).toBe(200)
    expect(source.headers.get('content-disposition')).toContain('attachment')
    expect(source.headers.get('cache-control')).toBe('private, no-store')
    expect(await source.text()).toBe('虚构调查原文')
    expect((await call(second, storyUrl + '/source', other.token)).status).toBe(404)
    expect((await call(second, storyUrl)).status).toBe(401)
    expect((await call(second, storyUrl, other.token)).status).toBe(404)
    expect((await call(second, storyUrl, other.token, 'DELETE')).status).toBe(404)
    expect(await call(second, storyUrl, owner.token, 'DELETE')).toEqual({ status: 200, body: { ok: true } })
    expect((await call(first, storyUrl, owner.token)).status).toBe(404)
    expect(await call(first, '/api/stories', owner.token)).toEqual({ status: 200, body: [] })
    const replacement = await upload(second, owner.token, '雾中的灯塔.txt', '不同版本')
    expect(replacement.body.ok).toBe(true)
    expect(replacement.body.id).not.toBe('雾中的灯塔.txt')
    expect((await call(first, storyUrl + '/source', owner.token)).status).toBe(404)
  })
  it('preserves a valid UTF-8 filename whose low bytes resemble corrupted text', async () => {
    const owner = await account(first)
    const name = '令亸亀.txt'
    expect(await upload(first, owner.token, name, 'fixture')).toEqual({
      status: 200, body: { ok: true, id: name, name },
    })
    const read = await call(second, '/api/stories/' + encodeURIComponent(name), owner.token)
    expect(read).toEqual({ status: 200, body: { name, content: 'fixture' } })
  })

  it('serves a bounded preview while preserving the full source read', async () => {
    const owner = await account(first)
    const body = '档'.repeat(30_000) + 'end of the original'
    expect((await upload(first, owner.token, 'long.txt', body)).body.ok).toBe(true)
    expect(await call(second, '/api/stories/long.txt?preview=1', owner.token)).toEqual({
      status: 200, body: { name: 'long.txt', content: '档'.repeat(16_000), truncated: true },
    })
    expect(await call(second, '/api/stories/long.txt', owner.token)).toEqual({
      status: 200, body: { name: 'long.txt', content: body },
    })
  })

  it('returns a retryable response when four text previews are already active', async () => {
    const owner = await account(first)
    expect((await upload(first, owner.token, 'held.txt', 'fixture')).body.ok).toBe(true)
    const pending: ServerResponse[] = []
    const stall = createHttpServer((_req, res) => { pending.push(res) })
    await new Promise<void>((resolve) => { stall.listen(0, '127.0.0.1', resolve) })
    try {
      const address = stall.address()
      if (!address || typeof address === 'string') throw new Error('could not start delayed storage fixture')
      const gateway = await startGateway(await freePort(), 'held-previews', `http://127.0.0.1:${address.port}`)
      const reads = Array.from({ length: 4 }, () => call(gateway, '/api/stories/held.txt?preview=1', owner.token))
      for (let i = 0; i < 50 && pending.length < 4; i++) await delay(100)
      expect(pending).toHaveLength(4)
      const gated = await fetch(gateway + '/api/stories/held.txt?preview=1', {
        headers: { Authorization: `Bearer ${owner.token}` }, signal: AbortSignal.timeout(2_000),
      })
      expect(gated.status).toBe(503)
      expect(gated.headers.get('retry-after')).toBe('5')
      expect(pending).toHaveLength(4)
      for (const response of pending) {
        response.statusCode = 500
        response.end()
      }
      expect((await Promise.all(reads)).map((response) => response.status)).toEqual([502, 502, 502, 502])
    } finally {
      stall.closeAllConnections()
      await new Promise<void>((resolve) => { stall.close(() => resolve()) })
    }
  }, 25_000)

  it('uses a stable owner-scoped cursor for equal timestamps across gateways', async () => {
    const owner = await account(first)
    const other = await account(second)
    for (const name of ['b.txt', 'c.txt', 'a.txt']) {
      expect((await upload(first, owner.token, name, name)).body.ok).toBe(true)
    }
    expect((await upload(second, other.token, 'y.txt', 'other owner')).body.ok).toBe(true)
    const db = new Pool({ connectionString: databaseUrl })
    try {
      // Fixture setup only: fix the ordering timestamp so the secondary key is exercised.
      await db.query('UPDATE story_catalog SET created_at = 1234 WHERE owner_id = $1 OR owner_id = $2', [owner.user.id, other.user.id])
    } finally {
      await db.end()
    }

    const firstPage = await call(first, '/api/stories?limit=2', owner.token)
    expect(firstPage).toEqual({ status: 200, body: {
      stories: [{ id: 'c.txt', name: 'c.txt' }, { id: 'b.txt', name: 'b.txt' }],
      nextCursor: expect.any(String), canPrepare: false,
    } })
    const next = '/api/stories?limit=2&cursor=' + encodeURIComponent(firstPage.body.nextCursor)
    expect(await call(second, next, owner.token)).toEqual({ status: 200, body: {
      stories: [{ id: 'a.txt', name: 'a.txt' }], nextCursor: null, canPrepare: false,
    } })
    expect(await call(second, next, other.token)).toEqual({ status: 200, body: {
      stories: [], nextCursor: null, canPrepare: false,
    } })
    expect(await call(first, '/api/stories?limit=2', other.token)).toEqual({ status: 200, body: {
      stories: [{ id: 'y.txt', name: 'y.txt' }], nextCursor: null, canPrepare: false,
    } })
    expect((await call(second, '/api/stories?cursor=not-a-cursor', owner.token)).status).toBe(400)
    expect((await call(second, '/api/stories?limit=101', owner.token)).status).toBe(400)
  })

  it('keeps both concurrent uploads readable and cleans an unpublished object after a catalog write fails', async () => {
    const owner = await account(first)
    const [left, right] = await Promise.all([
      upload(first, owner.token, 'same.txt', 'first source'),
      upload(second, owner.token, 'same.txt', 'second source'),
    ])
    expect(left.body.ok).toBe(true)
    expect(right.body.ok).toBe(true)
    expect([left.body.id, right.body.id]).toContain('same.txt')
    expect(left.body.id).not.toBe(right.body.id)
    const readUrl = (id: string) => '/api/stories/' + encodeURIComponent(id)
    expect((await call(second, readUrl(left.body.id), owner.token)).body.content).toBe('first source')
    expect((await call(first, readUrl(right.body.id), owner.token)).body.content).toBe('second source')

    const { bucket, ...config } = JSON.parse(s3Fixture!)
    const storage = new S3Client(config)
    const objects = new ListObjectsV2Command({ Bucket: bucket, Prefix: `stories/${owner.user.id}/sources/` })
    const db = new Pool({ connectionString: databaseUrl })
    const constraint = 'story_fixture_reject_' + randomBytes(5).toString('hex')
    try {
      const before = (await storage.send(objects)).Contents?.map(({ Key }) => Key)
      expect(before).toHaveLength(2)
      await db.query(`ALTER TABLE story_catalog ADD CONSTRAINT ${constraint} CHECK (story_id <> 'rejected-fixture.txt')`)
      expect((await upload(first, owner.token, 'rejected-fixture.txt', 'failed commit')).status).toBe(500)
      expect((await call(second, readUrl('rejected-fixture.txt'), owner.token)).status).toBe(404)
      expect((await upload(first, owner.token, 'same.txt', 'x'.repeat(1024 * 1024 + 1))).status).toBe(413)
      const malformed = new FormData()
      malformed.append('file', new Blob(['first file']), 'same.txt')
      malformed.append('file', new Blob(['extra file']), 'extra.txt')
      expect((await call(second, '/api/stories/upload', owner.token, 'POST', malformed)).status).toBe(400)
      expect((await storage.send(objects)).Contents?.map(({ Key }) => Key)).toEqual(before)
      expect((await call(second, readUrl(left.body.id), owner.token)).body.content).toBe('first source')
      expect((await call(first, readUrl(right.body.id), owner.token)).body.content).toBe('second source')
    } finally {
      await db.query(`ALTER TABLE story_catalog DROP CONSTRAINT IF EXISTS ${constraint}`)
      await db.end()
      storage.destroy()
    }
  })

  it('keeps metadata hidden when the private object write fails', async () => {
    const owner = await account(first)
    const unavailable = await freePort()
    const rejectingGateway = await startGateway(await freePort(), 'failed-upload', `http://127.0.0.1:${unavailable}`)
    const response = await upload(rejectingGateway, owner.token, 'unavailable.txt', 'unsaved source')
    expect(response).toEqual({ status: 502, body: { error: 'story object upload failed' } })
    expect((await call(second, '/api/stories/unavailable.txt', owner.token)).status).toBe(404)
    expect(await call(first, '/api/stories', owner.token)).toEqual({ status: 200, body: [] })
    expect((await upload(first, owner.token, 'unavailable.txt', 'retry source')).body.id).toBe('unavailable.txt')
    expect((await call(second, '/api/stories/unavailable.txt', owner.token)).body.content).toBe('retry source')
  }, 25_000)


  it('queues preparation through one gateway and restores its private status on another', async () => {
    const gateway = await startGateway(await freePort(), 'preparation', undefined, true)
    const otherGateway = await startGateway(await freePort(), 'preparation-second', undefined, true)
    const owner = await account(gateway)
    const other = await account(otherGateway)
    expect((await upload(gateway, owner.token, 'prepare.txt', 'fixture')).status).toBe(200)
    const route = '/api/stories/prepare.txt/preparation'
    const queued = await call(gateway, route, owner.token, 'POST')
    expect(queued).toEqual({
      status: 202,
      body: { activeRevision: null, job: { id: expect.any(String), version: expect.any(String), state: 'queued', stage: 'queued', percent: 0 } },
    })
    expect(await call(otherGateway, route, owner.token)).toEqual({ status: 200, body: queued.body })
    expect((await call(otherGateway, route, other.token)).status).toBe(404)
    expect((await call(otherGateway, route, other.token, 'POST')).status).toBe(404)
    expect((await call(otherGateway, route)).status).toBe(401)
    await call(gateway, '/api/stories/prepare.txt', owner.token, 'DELETE')
  }, 30_000)

  it('recovers after a killed preparation worker and publishes a single playable result', async () => {
    const gateway = await startGateway(await freePort(), 'recovery-first', undefined, true)
    const otherGateway = await startGateway(await freePort(), 'recovery-second', undefined, true)
    const owner = await account(gateway)
    const fixture = await readFile(new URL('../../../e2e/fixtures/demo-story.txt', import.meta.url), 'utf8')
    expect((await upload(gateway, owner.token, 'library.txt', fixture)).status).toBe(200)
    const route = '/api/stories/library.txt/preparation'
    const queued = await call(gateway, route, owner.token, 'POST')
    expect(queued.status).toBe(202)
    expect((await call(otherGateway, '/api/rag/stories?limit=2', owner.token)).body.stories).toEqual([])

    const stalledSource = createHttpServer((_req, _res) => {})
    await new Promise<void>((resolve) => { stalledSource.listen(0, '127.0.0.1', resolve) })
    const address = stalledSource.address()
    if (!address || typeof address === 'string') throw new Error('could not start storage boundary fault')
    const stalled = startProcess('src/workers/storyPreparation.ts', 'crash', `http://127.0.0.1:${address.port}`, true)
    try {
      await expect.poll(async () => (await call(otherGateway, route, owner.token)).body.job?.stage, { timeout: 8_000 }).toBe('read')
      expect((await call(gateway, route, owner.token, 'POST')).body.job.id).toBe(queued.body.job.id)
      await stopProcess(stalled, 'SIGKILL')
    } finally {
      stalledSource.closeAllConnections()
      await new Promise<void>((resolve) => { stalledSource.close(() => resolve()) })
    }

    const recoveryA = startProcess('src/workers/storyPreparation.ts', 'recovery-a', undefined, true)
    const recoveryB = startProcess('src/workers/storyPreparation.ts', 'recovery-b', undefined, true)
    await expect.poll(async () => (await call(otherGateway, route, owner.token)).body.job?.state, { timeout: 15_000 }).toBe('complete')
    const ready = await call(otherGateway, route, owner.token)
    const other = await account(otherGateway)
    const readActive = (userId: number) => loadActivePreparedStory(userId, 'library.txt', AbortSignal.timeout(5_000))
    await expect(readActive(other.user.id)).rejects.toThrow('prepared story not found')
    const prepared = await readActive(owner.user.id)
    expect(prepared).toMatchObject({
      revision: ready.body.activeRevision,
      sourceRevision: expect.any(String),
      sourceText: fixture.trim(),
      index: { scriptId: 'library.txt', chunkCount: expect.any(Number) },
      dossier: { scriptId: 'library.txt', sourceRevision: ready.body.activeRevision, quality: { degraded: false } },
      gaps: { scriptId: 'library.txt', sourceRevision: ready.body.activeRevision, storyChars: fixture.trim().length },
    })
    expect(prepared.sourceRevision).not.toBe(prepared.revision)
    expect(prepared.gaps.sceneAnchors.find((scene) => scene.id === 'scene_archive')?.matched).toBe(true)
    expect(prepared.index.docs[0]?.content).toContain('旧图书馆')
    expect(ready.body).toEqual({
      activeRevision: expect.any(String),
      job: { id: queued.body.job.id, version: expect.any(String), state: 'complete', stage: 'complete', percent: 100 },
    })
    expect((await call(gateway, '/api/stories?limit=2', owner.token)).body.stories).toEqual([
      { id: 'library.txt', name: 'library.txt', preparation: ready.body },
    ])
    expect((await call(gateway, '/api/rag/stories?limit=2', owner.token)).body.stories).toEqual([
      { storyId: 'library.txt', name: 'library.txt', indexedAt: expect.any(Number), chunkCount: expect.any(Number) },
    ])
    const { bucket, ...config } = JSON.parse(s3Fixture!)
    const s3 = new S3Client(config)
    try {
      const prefix = `stories/${owner.user.id}/prepared/`
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
      expect(listed.Contents?.map(({ Key }) => Key).sort()).toEqual(
        ['dossier', 'gaps', 'index', 'sourceText'].map((type) => prefix + ready.body.activeRevision + '/' + type),
      )
      const key = prefix + prepared.revision + '/gaps'
      const mismatchedGaps = Buffer.from(JSON.stringify({ ...prepared.gaps, sourceRevision: randomUUID() }))
      const sha256 = createHash('sha256').update(mismatchedGaps).digest('hex')
      // Simulate a repair that leaves a valid digest for the wrong source anchors.
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: mismatchedGaps, Metadata: { sha256 } }))
      await getPostgresPool().query(`
        UPDATE story_preparation_revisions SET objects = jsonb_set(objects, '{gaps}', $2::jsonb) WHERE revision = $1
      `, [prepared.revision, JSON.stringify({ size: mismatchedGaps.length, sha256 })])
      await expect(readActive(owner.user.id)).rejects.toThrow('prepared story objects are inconsistent')
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      await expect(readActive(owner.user.id)).rejects.toThrow('prepared story object read failed')
    } finally {
      s3.destroy()
      await Promise.all([stopProcess(recoveryA), stopProcess(recoveryB)])
    }
  }, 40_000)

  it.skipIf(!canInjectStorageFault)('keeps a previously prepared story ready when a new revision fails to publish its anchors', async () => {
    const gateway = await startGateway(await freePort(), 'partial-gateway', undefined, true)
    const owner = await account(gateway)
    const fixture = await readFile(new URL('../../../e2e/fixtures/demo-story.txt', import.meta.url), 'utf8')
    expect((await upload(gateway, owner.token, 'library.txt', fixture)).status).toBe(200)
    const route = '/api/stories/library.txt/preparation'
    expect((await call(gateway, route, owner.token, 'POST')).status).toBe(202)
    const worker = startProcess('src/workers/storyPreparation.ts', 'baseline-worker', undefined, true)
    try {
      await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.state, { timeout: 10_000 }).toBe('complete')
    } finally {
      await stopProcess(worker)
    }
    const previous = (await call(gateway, route, owner.token)).body
    const readyStories = await call(gateway, '/api/rag/stories?limit=2', owner.token)
    const queued = await call(gateway, route, owner.token, 'POST')
    expect(queued.body).toEqual({
      activeRevision: previous.activeRevision,
      job: { id: expect.any(String), version: expect.any(String), state: 'queued', stage: 'queued', percent: 0 },
    })

    const { endpoint } = JSON.parse(s3Fixture!)
    let rejectedAnchorWrites = 0
    const storage = createHttpServer((request, response) => {
      const url = new URL(request.url!, endpoint)
      if (request.method === 'PUT' && url.pathname.endsWith('/gaps')) {
        rejectedAnchorWrites++
        request.resume()
        response.writeHead(503).end()
        return
      }
      const upstream = proxyRequest(url, {
        method: request.method, headers: request.headers,
      }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
      })
      upstream.on('error', () => response.writeHead(502).end())
      request.pipe(upstream)
    })
    await new Promise<void>((resolve) => { storage.listen(0, '127.0.0.1', resolve) })
    const address = storage.address()
    if (!address || typeof address === 'string') throw new Error('could not start storage boundary fault')
    const partial = startProcess('src/workers/storyPreparation.ts', 'partial-worker', `http://127.0.0.1:${address.port}`, true)
    try {
      await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.state, { timeout: 10_000 }).toBe('failed')
      expect((await call(gateway, route, owner.token)).body).toEqual({
        activeRevision: previous.activeRevision,
        job: { id: queued.body.job.id, version: expect.any(String), state: 'failed', stage: 'publish_failed', percent: 90 },
      })
      expect(rejectedAnchorWrites).toBe(1)
      expect(await call(gateway, '/api/rag/stories?limit=2', owner.token)).toEqual(readyStories)
      const current = await loadActivePreparedStory(owner.user.id, 'library.txt', AbortSignal.timeout(5_000))
      expect(current.revision).toBe(previous.activeRevision)
      expect(current.sourceText).toBe(fixture.trim())
    } finally {
      await stopProcess(partial)
      storage.closeAllConnections()
      await new Promise<void>((resolve) => { storage.close(() => resolve()) })
    }
  }, 35_000)

  it('keeps a partially OCR’d PDF out of the prepared story catalog', async () => {
    const gateway = await startGateway(await freePort(), 'ocr-gateway', undefined, true)
    const owner = await account(gateway)
    const markers = Array.from({ length: 33 }, (_, index) => String(index + 1).padStart(2, '0'))
    const pdf = await makePdfWithTextAndEmbeddedImages('A readable source section', [markers])
    expect((await upload(gateway, owner.token, 'partial.pdf', new Uint8Array(pdf))).status).toBe(200)
    const route = '/api/stories/partial.pdf/preparation'
    const queued = await call(gateway, route, owner.token, 'POST')
    const worker = startProcess('src/workers/storyPreparation.ts', 'ocr-worker', undefined, true)
    try {
      await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.state, { timeout: 12_000 }).toBe('failed')
      expect((await call(gateway, route, owner.token)).body).toEqual({
        activeRevision: null,
        job: { id: queued.body.job.id, version: expect.any(String), state: 'failed', stage: 'source_failed', percent: 5 },
      })
      expect((await call(gateway, '/api/rag/stories?limit=2', owner.token)).body.stories).toEqual([])
    } finally {
      await stopProcess(worker)
    }
  }, 30_000)
})
