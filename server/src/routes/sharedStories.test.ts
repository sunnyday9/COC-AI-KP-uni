import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as proxyRequest, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Pool } from 'pg'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
const startupLogs = new WeakMap<ChildProcess, string>()
let permanentGatewayCount = 0
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

function startProcess(entry: string, dir: string, endpointOverride?: string, prepare = false, port?: number, overrides?: NodeJS.ProcessEnv): ChildProcess {
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
      ENABLE_SHARED_ROOMS: '0',
      SHARED_ROOM_FIXTURE_DIR: undefined,
      PORT: port === undefined ? undefined : String(port),
      MOCK_AI: '1',
      STORY_PREPARATION_LEASE_MS: '30000',
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
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const capture = (chunk: Buffer) => {
    startupLogs.set(child, ((startupLogs.get(child) ?? '') + chunk.toString()).slice(-4_096))
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
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

async function startGateway(port: number, dir: string, endpointOverride?: string, prepare = false, overrides?: NodeJS.ProcessEnv): Promise<string> {
  const child = startProcess('src/app.ts', dir, endpointOverride, prepare, port, overrides)
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  let status: number | undefined
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1_000) }).catch(() => null)
    if (response?.ok) return url
    status = response?.status
    await delay(100)
  }
  const { credentials } = JSON.parse(s3Fixture!)
  const sensitive = [databaseUrl, secret, password, credentials.accessKeyId, credentials.secretAccessKey]
  let output = startupLogs.get(child) ?? ''
  for (const value of sensitive) {
    if (value) output = output.replaceAll(value, '<REDACTED>')
  }
  throw new Error(
    'story gateway never became ready (fixture ' + dir + ', status ' + String(status) +
    ', process exit ' + String(child.exitCode ?? child.signalCode) + ')\n' + output,
  )
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
    permanentGatewayCount = children.length
  }, 25_000)

  afterEach(async () => {
    const temporaryProcesses = children.splice(permanentGatewayCount)
    await Promise.all(temporaryProcesses.map((child) => stopProcess(child)))
  })

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

  it.each([false, true])('keeps a pinned story across renewal, transfer and restart (worker failover: %s)', async (failover) => {
    const rooms = {
      ENABLE_SHARED_ROOMS: '1',
      ENABLE_ROOM_WORKER_FAILOVER: failover ? '1' : '0',
      ROOM_WORKER_LEASE_MS: '3000',
    }
    let gateway = await startGateway(await freePort(), 'pinned-gateway', undefined, true, rooms)
    let gameplay = children.at(-1)!
    const owner = await account(gateway)
    const host = await account(gateway)
    const storyId = 'pinned-story.txt'
    const fixture = await readFile(new URL('../../../e2e/fixtures/demo-story.txt', import.meta.url), 'utf8')
    expect((await upload(gateway, owner.token, storyId, fixture)).status).toBe(200)
    const storyPath = '/api/stories/' + storyId
    const route = storyPath + '/preparation'
    const worker = startProcess('src/workers/storyPreparation.ts', 'pinned-worker', undefined, true)
    const { bucket, ...s3Config } = JSON.parse(s3Fixture!)
    const s3 = new S3Client(s3Config)
    const sockets: WebSocket[] = []
    const sheet = { playerName: 'Archivist', derived: { hp: 10, hpMax: 10, san: 50, sanMax: 50 }, attributes: {}, skills: {} }
    async function prepare(): Promise<string> {
      const requested = await call(gateway, route, owner.token, 'POST')
      expect(requested.status).toBe(202)
      const jobId = requested.body.job.id
      await expect.poll(async () => (await call(gateway, route, owner.token)).body.job, { timeout: 15_000 }).toMatchObject({
        id: jobId, state: 'complete',
      })
      return (await call(gateway, route, owner.token)).body.activeRevision
    }
    const post = (path: string, token: string, body: unknown) => call(gateway, path, token, 'POST', JSON.stringify(body))
    const solo = (token: string, workflow: 'dossier' | 'rag') =>
      post('/api/rooms/solo', token, { storyId, workflow, name: 'Archivist', sheet })
    function roomSocket(token: string, roomId: string) {
      const ws = new WebSocket(gateway.replace('http:', 'ws:') + '/ws?token=' + encodeURIComponent(token))
      const frames: {
        type: string
        eventType?: string
        payload?: { message?: { role: string; content: string } }
        actionId?: string
        code?: string
        error?: string
        messageId?: string
        status?: string
      }[] = []
      ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString())) })
      ws.once('open', () => ws.send(JSON.stringify({ type: 'room:join', roomId })))
      sockets.push(ws)
      return {
        ready: () => expect.poll(() => frames.some((frame) => frame.type === 'room:state'), { timeout: 12_000 }).toBe(true),
        kpMessages: () => frames.flatMap((frame) =>
          frame.eventType === 'message_appended' && frame.payload?.message?.role === 'kp' ? [frame.payload.message.content] : [],
        ),
        countKp: () => frames.filter((frame) => frame.eventType === 'message_appended' && frame.payload?.message?.role === 'kp').length,
        error: () => frames.find((frame) => frame.type === 'room:error')?.error,
        receipt: (actionId: string) => frames.findLast((frame) =>
          frame.type === 'room:action:result' && frame.actionId === actionId,
        ),
        chat: (content: string, actionId?: string) => ws.send(JSON.stringify({
          type: 'room:action', roomId, actionId, action: { type: 'chat', payload: { content } },
        })),
      }
    }
    try {
      const originalRevision = await prepare()
      expect((await call(gateway, '/api/rag/stories?limit=2', owner.token)).body.canStartInvestigation).toBe(true)
      expect((await solo(host.token, 'dossier')).status).toBe(409)

      const oldSolo = await solo(owner.token, 'dossier')
      expect(oldSolo.status).toBe(200)
      const multi = await post('/api/rooms', owner.token, { storyId, workflow: 'rag' })
      expect(multi.status).toBe(200)
      const multiPath = '/api/rooms/' + multi.body.roomId
      expect((await post('/api/rooms/join', host.token, { inviteCode: multi.body.inviteCode })).status).toBe(200)
      for (const member of [owner, host]) {
        const card = await post('/api/characters', member.token, { name: 'Archivist', sheet })
        expect(card.status).toBe(200)
        expect((await post(multiPath + '/character', member.token, { characterId: card.body.id })).status).toBe(200)
      }
      expect((await post(multiPath + '/start', owner.token, { storyId })).status).toBe(200)
      expect((await post(multiPath + '/transfer', owner.token, { userId: host.user.id })).status).toBe(200)
      expect((await call(gateway, multiPath + '/settings', host.token, 'PUT', '{"turnWindowMs":0}')).status).toBe(200)
      const oldMulti = roomSocket(host.token, multi.body.roomId)
      await oldMulti.ready()
      await expect.poll(oldMulti.countKp, { timeout: 12_000 }).toBe(1)

      const renewedRevision = await prepare()
      expect(renewedRevision).not.toBe(originalRevision)
      const newSolo = await solo(owner.token, 'rag')
      expect(newSolo.status).toBe(200)
      const newer = roomSocket(owner.token, newSolo.body.roomId)
      await newer.ready()
      await expect.poll(newer.countKp, { timeout: 12_000 }).toBe(1)
      const earlierAction = { id: randomUUID(), content: 'Check the index for an archive request.' }
      newer.chat(earlierAction.content, earlierAction.id)
      await expect.poll(() => newer.receipt(earlierAction.id), { timeout: 12_000 }).toMatchObject({
        status: 'pending', messageId: expect.any(String),
      })
      const earlierMessageId = newer.receipt(earlierAction.id)!.messageId
      await expect.poll(newer.countKp, { timeout: 12_000 }).toBe(2)

      const prefix = `stories/${owner.user.id}/prepared/`
      const readArtifact = async (kind: 'dossier' | 'gaps' | 'index') => {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + renewedRevision + '/' + kind }))
        return JSON.parse(await object.Body!.transformToString())
      }
      // Simulate a storage repair that records a fresh, valid digest for each
      // bad payload. The REST gate must catch the semantic inconsistency.
      const db = new Pool({ connectionString: databaseUrl })
      const replaceArtifact = async (kind: 'dossier' | 'gaps' | 'index', value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value))
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: prefix + renewedRevision + '/' + kind, Body: bytes, Metadata: { sha256 },
        }))
        await db.query(`
          UPDATE story_preparation_revisions SET objects = jsonb_set(objects, ARRAY[$2::text], $3::jsonb)
          WHERE revision = $1
        `, [renewedRevision, kind, JSON.stringify({ size: bytes.length, sha256 })])
      }
      try {
        const [dossier, gaps, index] = await Promise.all([readArtifact('dossier'), readArtifact('gaps'), readArtifact('index')])
        const [firstDoc, ...otherDocs] = index.docs
        for (const malformedIndex of [
          { ...index, idf: { term: 1 } },
          { ...index, docs: [{ ...firstDoc, tf: ['term', 1] }, ...otherDocs] },
          { ...index, docs: [{ ...firstDoc, tfidf: [['term', '1']] }, ...otherDocs] },
          { ...index, docs: [{ ...firstDoc, vector: [1, null] }, ...otherDocs] },
        ]) {
          await replaceArtifact('index', malformedIndex)
          expect.soft((await solo(owner.token, 'rag')).status).toBe(409)
        }
        await replaceArtifact('index', index)

        const spans = gaps.spans.length > 0 ? [] : [{ start: 0, end: 1, chars: 1, preview: 'x' }]
        const gapChars = spans.length
        await replaceArtifact('gaps', {
          ...gaps, spans, gapChars, gapCount: spans.length,
          gapPct: Math.round((gapChars / gaps.storyChars) * 1000) / 10,
        })
        expect.soft((await solo(owner.token, 'dossier')).status).toBe(409)
        await replaceArtifact('gaps', gaps)
        const { clues: _clues, npcs: _npcs, ...malformedDossier } = dossier
        await replaceArtifact('dossier', malformedDossier)
        expect.soft((await solo(owner.token, 'dossier')).status).toBe(409)
        const [firstScene, ...otherScenes] = dossier.scenes
        await replaceArtifact('dossier', { ...dossier, scenes: [{ ...firstScene, npcIds: 'invalid-array' }, ...otherScenes] })
        expect.soft((await solo(owner.token, 'dossier')).status).toBe(409)
        await replaceArtifact('dossier', dossier)

        const reveal = dossier.truths[0].revealScene
        const anchor = gaps.sceneAnchors.find((candidate: { id: string; name: string }) => candidate.id === reveal || candidate.name === reveal)
        expect(anchor?.starts?.[0]).toBeTypeOf('number')
        anchor.starts[0] += 1
        expect(anchor.starts[0]).toBeLessThan(gaps.storyChars)
        await replaceArtifact('gaps', gaps)
        expect.soft((await solo(owner.token, 'rag')).status).toBe(409)
        expect.soft((await solo(owner.token, 'dossier')).status).toBe(409)
      } finally {
        await db.end()
      }
      const oldAnchors = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + originalRevision + '/gaps' }))
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: prefix + renewedRevision + '/gaps', Body: await oldAnchors.Body!.transformToByteArray(),
      }))
      const cardsBeforeRejectedStarts = (await call(gateway, '/api/characters', owner.token)).body
      expect((await solo(owner.token, 'rag')).status).toBe(409)
      expect((await solo(owner.token, 'dossier')).status).toBe(409)
      expect((await call(gateway, '/api/characters', owner.token)).body).toEqual(cardsBeforeRejectedStarts)
      const blockedLobby = await post('/api/rooms', owner.token, { storyId, workflow: 'rag' })
      expect(blockedLobby.status).toBe(200)
      const blockedPath = '/api/rooms/' + blockedLobby.body.roomId
      expect((await post(blockedPath + '/character', owner.token, { characterId: oldSolo.body.characterId })).status).toBe(200)
      expect((await post(blockedPath + '/start', owner.token, { storyId })).status).toBe(409)
      expect((await call(gateway, blockedPath, owner.token)).body.phase).toBe('lobby')

      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + renewedRevision + '/dossier' }))
      expect((await call(gateway, storyPath, owner.token, 'DELETE')).status).toBe(200)
      expect((await call(gateway, storyPath, owner.token)).status).toBe(404)
      expect((await solo(owner.token, 'dossier')).status).toBe(409)
      await stopProcess(gameplay)
      if (failover) {
        const roomIds = [oldSolo.body.roomId, multi.body.roomId, newSolo.body.roomId]
        await expect.poll(async () => {
          const result = await getPostgresPool().query<{ live: number }>(`
            SELECT count(*)::int AS live FROM rooms
            WHERE room_id = ANY($1::text[]) AND worker_expires_at > clock_timestamp()
          `, [roomIds])
          return result.rows[0]?.live
        }, { timeout: 12_000 }).toBe(0)
      }
      gateway = await startGateway(await freePort(), 'pinned-restarted', undefined, true, rooms)
      gameplay = children.at(-1)!

      // The same room is authorized by membership after catalog deletion;
      // its successor cannot repin the room or borrow the owner's catalog.
      expect((await post(multiPath + '/start', host.token, { storyId })).status).toBe(200)
      expect((await post(multiPath + '/start', host.token, { storyId: 'replacement.txt' })).status).toBe(409)
      const resumedMulti = roomSocket(host.token, multi.body.roomId)
      const resumedSolo = roomSocket(owner.token, oldSolo.body.roomId)
      await Promise.all([resumedMulti.ready(), resumedSolo.ready()])
      resumedMulti.chat('Enter the archive by the front door.')
      await expect.poll(resumedMulti.countKp, { timeout: 12_000 }).toBe(1)
      await expect.poll(resumedSolo.countKp, { timeout: 12_000 }).toBe(1)
      resumedSolo.chat('请查阅档案，确认一下旧图书馆的情报。')
      await expect.poll(resumedSolo.countKp, { timeout: 12_000 }).toBe(2)
      expect(resumedSolo.kpMessages().at(-1)).toContain('你确认了旧图书馆的档案')

      const corrupt = roomSocket(owner.token, newSolo.body.roomId)
      await corrupt.ready()
      // A lost receipt can be recovered even if its story is currently
      // unreadable. Only new actions depend on gameplay readiness.
      corrupt.chat(earlierAction.content, earlierAction.id)
      await expect.poll(() => corrupt.receipt(earlierAction.id), { timeout: 12_000 }).toMatchObject({
        status: 'completed', messageId: earlierMessageId,
      })
      const newActionId = randomUUID()
      corrupt.chat('Inspect the sealed box', newActionId)
      await expect.poll(() => corrupt.receipt(newActionId), { timeout: 12_000 }).toMatchObject({
        status: 'retry', code: 'story_unavailable',
      })
      corrupt.chat('Search the archive cabinet')
      await expect.poll(corrupt.error, { timeout: 12_000 }).toBe('The pinned story revision is unavailable.')
      expect(corrupt.countKp()).toBe(0)
    } finally {
      await stopProcess(gameplay)
      for (const socket of sockets) socket.terminate()
      await stopProcess(worker)
      s3.destroy()
    }
  }, 85_000)

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
    const stalled = startProcess('src/workers/storyPreparation.ts', 'crash', `http://127.0.0.1:${address.port}`, true,
      undefined, { STORY_PREPARATION_LEASE_MS: '3000' })
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

  it('replays an operation across gateways and rejects a competing explicit submission', async () => {
    const [left, right] = await Promise.all([
      startGateway(await freePort(), 'operation-left', undefined, true),
      startGateway(await freePort(), 'operation-right', undefined, true),
    ])
    const owner = await account(left)
    const other = await account(right)
    const route = '/api/stories/operations.txt/preparation'
    const payload = JSON.stringify({ operationId: 'fixture-operation-1' })
    await upload(left, owner.token, 'operations.txt', 'fixture')
    await upload(right, other.token, 'operations.txt', 'another fixture')
    const submitted = await call(left, route, owner.token, 'POST', payload)
    expect(submitted.status).toBe(202)
    expect(await call(right, route, owner.token, 'POST', payload)).toEqual(submitted)
    expect(await call(right, route, owner.token, 'POST')).toEqual(submitted)
    const conflict = await call(right, route, owner.token, 'POST', JSON.stringify({ operationId: 'fixture-operation-2' }))
    expect(conflict).toEqual({ status: 409, body: { error: expect.any(String) } })
    const independent = await call(right, route, other.token, 'POST', payload)
    expect(independent.status).toBe(202)
    expect(independent.body.job.id).not.toBe(submitted.body.job.id)
    await call(left, '/api/stories/operations.txt', owner.token, 'DELETE')
    await call(right, '/api/stories/operations.txt', other.token, 'DELETE')
  }, 30_000)

  it('cancels and explicitly retries a selected job without taking over a replacement', async () => {
    const gateway = await startGateway(await freePort(), 'job-actions', undefined, true)
    const owner = await account(gateway)
    const other = await account(gateway)
    const route = '/api/stories/actions.txt/preparation'
    await upload(gateway, owner.token, 'actions.txt', 'fixture')
    const first = await call(gateway, route, owner.token, 'POST', JSON.stringify({ operationId: 'initial-action' }))
    const job = route + '/' + first.body.job.id
    const retry = JSON.stringify({ operationId: 'retry-action' })
    expect((await call(gateway, job + '/retry', owner.token, 'POST', retry)).status).toBe(409)
    expect((await call(gateway, job + '/cancel', other.token, 'POST')).status).toBe(404)
    const cancelled = await call(gateway, job + '/cancel', owner.token, 'POST')
    expect(cancelled).toMatchObject({ status: 200, body: { job: { id: first.body.job.id, state: 'cancelled' } } })
    expect(await call(gateway, job + '/cancel', owner.token, 'POST')).toEqual(cancelled)
    expect(await call(gateway, route, owner.token, 'POST', JSON.stringify({ operationId: 'initial-action' })))
      .toEqual({ ...cancelled, status: 202 })
    const replacement = await call(gateway, job + '/retry', owner.token, 'POST', retry)
    expect(replacement).toMatchObject({ status: 202, body: { job: { state: 'queued' } } })
    expect(replacement.body.job.id).not.toBe(first.body.job.id)
    expect(await call(gateway, job + '/retry', owner.token, 'POST', retry)).toEqual(replacement)
    expect((await call(gateway, route, owner.token, 'POST', retry)).status).toBe(409)
    expect((await call(gateway, job + '/retry', owner.token, 'POST', JSON.stringify({ operationId: 'new-retry-action' }))).status).toBe(409)
    expect(await call(gateway, job + '/cancel', owner.token, 'POST')).toEqual(cancelled)
    expect((await call(gateway, route, owner.token)).body).toEqual(replacement.body)
    await call(gateway, '/api/stories/actions.txt', owner.token, 'DELETE')
  }, 25_000)

  it('limits each owner and admits only one request for the last shared queue slot', async () => {
    const limits = { STORY_PREPARATION_PENDING_PER_ACCOUNT: '1', STORY_PREPARATION_PENDING_GLOBAL: '2' }
    const [left, right] = await Promise.all([
      startGateway(await freePort(), 'capacity-left', undefined, true, limits),
      startGateway(await freePort(), 'capacity-right', undefined, true, limits),
    ])
    const owner = await account(left)
    const other = await account(right)
    const third = await account(left)
    const start = (gateway: string, token: string, file: string) =>
      call(gateway, '/api/stories/' + file + '/preparation', token, 'POST')
    const stop = (gateway: string, token: string, file: string, jobId: string) =>
      call(gateway, '/api/stories/' + file + '/preparation/' + jobId + '/cancel', token, 'POST')
    const body = 'fixture'
    await upload(left, owner.token, 'a.txt', body)
    const first = await start(left, owner.token, 'a.txt')
    expect(first.status).toBe(202)
    expect((await upload(left, owner.token, 'b.txt', body)).status).toBe(200)
    const personal = await fetch(left + '/api/stories/b.txt/preparation', {
      method: 'POST', headers: { Authorization: 'Bearer ' + owner.token },
    })
    expect(personal.status).toBe(503)
    expect(personal.headers.get('retry-after')).toBe('5')
    expect((await personal.json()).error).toContain('你的准备任务')
    expect(await start(right, owner.token, 'a.txt')).toEqual(first)
    expect((await upload(right, other.token, 'other.txt', body)).status).toBe(200)
    const independent = await start(right, other.token, 'other.txt')
    expect(independent.status).toBe(202)
    expect((await upload(left, third.token, 'third.txt', body)).status).toBe(200)
    expect(await start(left, third.token, 'third.txt')).toMatchObject({ status: 503, body: { error: expect.stringContaining('准备队列') } })
    expect((await stop(right, owner.token, 'a.txt', first.body.job.id)).status).toBe(200)
    const remaining = await Promise.all([start(left, owner.token, 'b.txt'), start(right, third.token, 'third.txt')])
    expect(remaining.map(({ status }) => status).sort()).toEqual([202, 503])
    for (const [index, token, file] of [[0, owner.token, 'b.txt'], [1, third.token, 'third.txt']] as const) {
      const admitted = remaining[index]!
      if (admitted.status === 202) await stop(left, token, file, admitted.body.job.id)
    }
    await stop(left, other.token, 'other.txt', independent.body.job.id)
  }, 30_000)



  async function expectDatabaseWait(db: Pool, fragment: string) {
    await expect.poll(async () => {
      const result = await db.query<{ waiting: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND strpos(query, $1) > 0) AS waiting
      `, [fragment])
      return result.rows[0]?.waiting
    }, { timeout: 5_000 }).toBe(true)
  }

  it('does not hold the global admission lock while waiting on one story', async () => {
    const gateway = await startGateway(await freePort(), 'contended-admission', undefined, true)
    const blockedOwner = await account(gateway)
    const freeOwner = await account(gateway)
    await upload(gateway, blockedOwner.token, 'blocked.txt', 'fixture')
    await upload(gateway, freeOwner.token, 'free.txt', 'fixture')
    const db = new Pool({ connectionString: databaseUrl })
    const barrier = await db.connect()
    let blocked: ReturnType<typeof call> | undefined
    try {
      await barrier.query('BEGIN')
      await barrier.query('SELECT 1 FROM story_catalog WHERE owner_id = $1 AND story_id = $2 FOR UPDATE', [blockedOwner.user.id, 'blocked.txt'])
      blocked = call(gateway, '/api/stories/blocked.txt/preparation', blockedOwner.token, 'POST')
      await expectDatabaseWait(db, 'SELECT source_revision, active_preparation_revision FROM story_catalog')
      const free = await fetch(gateway + '/api/stories/free.txt/preparation', {
        method: 'POST', headers: { Authorization: 'Bearer ' + freeOwner.token }, signal: AbortSignal.timeout(3_000),
      })
      expect(free.status).toBe(202)
      await barrier.query('COMMIT')
      expect((await blocked).status).toBe(202)
    } finally {
      await barrier.query('ROLLBACK')
      barrier.release()
      await blocked?.catch(() => {})
      await db.end()
      await call(gateway, '/api/stories/blocked.txt', blockedOwner.token, 'DELETE')
      await call(gateway, '/api/stories/free.txt', freeOwner.token, 'DELETE')
    }
  }, 45_000)

  it('cancels a job admitted while deletion waits for the story lock', async () => {
    const gateway = await startGateway(await freePort(), 'delete-enqueue', undefined, true, { STORY_PREPARATION_PENDING_PER_ACCOUNT: '1' })
    const owner = await account(gateway)
    await upload(gateway, owner.token, 'deleting.txt', 'fixture')
    await upload(gateway, owner.token, 'next.txt', 'fixture')
    const db = new Pool({ connectionString: databaseUrl })
    const barrier = await db.connect()
    let pending: ReturnType<typeof call> | undefined
    let removing: ReturnType<typeof call> | undefined
    try {
      await barrier.query('BEGIN')
      await barrier.query('SELECT pg_advisory_xact_lock(17407, 117)')
      pending = call(gateway, '/api/stories/deleting.txt/preparation', owner.token, 'POST')
      await expectDatabaseWait(db, 'pg_advisory_xact_lock(17407, 117)')
      removing = call(gateway, '/api/stories/deleting.txt', owner.token, 'DELETE')
      await expectDatabaseWait(db, 'UPDATE story_catalog SET deleted_at')
      await barrier.query('COMMIT')
      const admitted = await pending
      expect(admitted.status).toBe(202)
      expect((await removing).status).toBe(200)
      const deletedJob = await db.query('SELECT state FROM story_preparation_jobs WHERE job_id = $1', [admitted.body.job.id])
      expect(deletedJob.rows[0]?.state).toBe('cancelled')
      expect((await call(gateway, '/api/stories/next.txt/preparation', owner.token, 'POST')).status).toBe(202)
    } finally {
      await barrier.query('ROLLBACK')
      barrier.release()
      await Promise.allSettled([pending, removing])
      await db.end()
      await call(gateway, '/api/stories/next.txt', owner.token, 'DELETE')
    }
  }, 45_000)

  it('keeps an in-flight heartbeat charged against its account quota', async () => {
    const gateway = await startGateway(await freePort(), 'heartbeat-quota', undefined, true, { STORY_PREPARATION_PENDING_PER_ACCOUNT: '1' })
    const owner = await account(gateway)
    await upload(gateway, owner.token, 'slot.txt', 'fixture')
    await upload(gateway, owner.token, 'waiting.txt', 'fixture')
    const queued = await call(gateway, '/api/stories/slot.txt/preparation', owner.token, 'POST')
    const db = new Pool({ connectionString: databaseUrl })
    const heartbeat = await db.connect()
    try {
      await db.query(`
        UPDATE story_preparation_jobs SET state = 'running', attempt = attempt_limit,
          lease_expires_at = clock_timestamp() + interval '2 seconds' WHERE job_id = $1
      `, [queued.body.job.id])
      await heartbeat.query('BEGIN')
      expect((await heartbeat.query(`
        UPDATE story_preparation_jobs SET lease_expires_at = clock_timestamp() + interval '2 minutes'
        WHERE job_id = $1 AND lease_expires_at > clock_timestamp()
      `, [queued.body.job.id])).rowCount).toBe(1)
      await expect.poll(async () => {
        const result = await db.query<{ expired: boolean }>(
          'SELECT lease_expires_at <= clock_timestamp() AS expired FROM story_preparation_jobs WHERE job_id = $1', [queued.body.job.id])
        return result.rows[0]?.expired
      }, { timeout: 6_000 }).toBe(true)
      expect((await call(gateway, '/api/stories/waiting.txt/preparation', owner.token, 'POST')).status).toBe(503)
      await heartbeat.query('COMMIT')
      expect((await call(gateway, '/api/stories/slot.txt/preparation', owner.token)).body.job?.state).toBe('running')
    } finally {
      await heartbeat.query('ROLLBACK')
      heartbeat.release()
      await db.end()
      await call(gateway, '/api/stories/slot.txt', owner.token, 'DELETE')
      await call(gateway, '/api/stories/waiting.txt', owner.token, 'DELETE')
    }
  }, 40_000)

  it('releases the slot of a job deleted during a catalog-only rollout', async () => {
    const gateway = await startGateway(await freePort(), 'legacy-deleted', undefined, true, { STORY_PREPARATION_PENDING_PER_ACCOUNT: '1' })
    const owner = await account(gateway)
    await upload(gateway, owner.token, 'retired.txt', 'fixture')
    await upload(gateway, owner.token, 'fresh.txt', 'fixture')
    expect((await call(gateway, '/api/stories/retired.txt/preparation', owner.token, 'POST')).status).toBe(202)
    expect((await call(first, '/api/stories/retired.txt', owner.token, 'DELETE')).status).toBe(200)
    expect((await call(gateway, '/api/stories/fresh.txt/preparation', owner.token, 'POST')).status).toBe(202)
    await call(gateway, '/api/stories/fresh.txt', owner.token, 'DELETE')
  }, 30_000)

  it('continues expiring a backlog larger than one batch while admissions are full', async () => {
    const gateway = await startGateway(await freePort(), 'expiry-backlog', undefined, true, { STORY_PREPARATION_PENDING_PER_ACCOUNT: '1' })
    const owner = await account(gateway)
    await upload(gateway, owner.token, 'fresh.txt', 'fixture')
    const db = new Pool({ connectionString: databaseUrl })
    try {
      // Seed expired work from a previous rollout without starting a worker.
      await db.query(`
        WITH imported AS (
          INSERT INTO story_catalog (owner_id, story_id, name, source_revision, source_size, extension, created_at)
          SELECT $1, 'expired-' || n || '.txt', 'expired fixture', gen_random_uuid(), 7, '.txt', 1
          FROM generate_series(1, 258) AS n
          RETURNING owner_id, story_id, source_revision
        )
        INSERT INTO story_preparation_jobs
          (job_id, owner_id, story_id, source_revision, state, stage, percent, deadline_at)
        SELECT gen_random_uuid(), owner_id, story_id, source_revision, 'queued', 'queued', 0,
          clock_timestamp() - interval '1 minute'
        FROM imported
      `, [owner.user.id])
      const route = '/api/stories/fresh.txt/preparation'
      const payload = JSON.stringify({ operationId: 'admit-after-reaping' })
      expect((await call(gateway, route, owner.token, 'POST', payload)).status).toBe(503)
      expect((await call(gateway, route, owner.token, 'POST', payload)).status).toBe(202)
    } finally {
      await db.end()
      await call(gateway, '/api/stories/fresh.txt', owner.token, 'DELETE')
    }
  }, 35_000)


  it('times out queued work without a worker and permits explicit retry', async () => {
    const gateway = await startGateway(await freePort(), 'deadline', undefined, true, { STORY_PREPARATION_DEADLINE_MS: '1200' })
    const owner = await account(gateway)
    const route = '/api/stories/timeout.txt/preparation'
    await upload(gateway, owner.token, 'timeout.txt', 'fixture')
    const queued = await call(gateway, route, owner.token, 'POST', JSON.stringify({ operationId: 'timeout-operation' }))
    expect(queued.status).toBe(202)
    await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.stage, { timeout: 6_000 }).toBe('timed_out')
    expect((await call(gateway, route, owner.token)).body).toMatchObject({
      activeRevision: null, job: { id: queued.body.job.id, state: 'failed' },
    })
    const retried = await call(gateway, route + '/' + queued.body.job.id + '/retry', owner.token,
      'POST', JSON.stringify({ operationId: 'retry-timeout' }))
    expect(retried.status).toBe(202)
    expect(retried.body.job.id).not.toBe(queued.body.job.id)
    await call(gateway, '/api/stories/timeout.txt', owner.token, 'DELETE')
  }, 20_000)

  it('stops reclaiming after the stored attempt budget expires', async () => {
    const gateway = await startGateway(await freePort(), 'attempts', undefined, true, { STORY_PREPARATION_MAX_ATTEMPTS: '2' })
    const owner = await account(gateway)
    const route = '/api/stories/interrupted.txt/preparation'
    await upload(gateway, owner.token, 'interrupted.txt', 'fixture')
    const submitted = await call(gateway, route, owner.token, 'POST')
    expect(submitted.status).toBe(202)
    const hits: string[] = []
    const stalled = createHttpServer((req, _res) => { hits.push(req.url ?? '') })
    await new Promise<void>((resolve) => { stalled.listen(0, '127.0.0.1', resolve) })
    const address = stalled.address()
    if (!address || typeof address === 'string') throw new Error('could not open storage fault fixture')
    const endpoint = 'http://127.0.0.1:' + address.port
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const worker = startProcess('src/workers/storyPreparation.ts', 'attempt-' + attempt, endpoint, true,
          undefined, { STORY_PREPARATION_LEASE_MS: '3000' })
        try {
          await expect.poll(() => hits.length, { timeout: 12_000 }).toBe(attempt)
          expect((await call(gateway, route, owner.token)).body.job).toMatchObject({ id: submitted.body.job.id, state: 'running' })
        } finally {
          await stopProcess(worker, 'SIGKILL')
        }
      }
      await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.stage, { timeout: 8_000 })
        .toBe('retry_exhausted')
      expect((await call(gateway, route, owner.token)).body).toMatchObject({
        activeRevision: null, job: { id: submitted.body.job.id, state: 'failed' },
      })
    } finally {
      stalled.closeAllConnections()
      await new Promise<void>((resolve) => { stalled.close(() => resolve()) })
    }
  }, 40_000)

  it('dispatches a waiting owner before another job of the last-served owner', async () => {
    const gateway = await startGateway(await freePort(), 'fairness', undefined, true)
    const owner = await account(gateway)
    const other = await account(gateway)
    for (const [token, name] of [[owner.token, 'first.txt'], [owner.token, 'second.txt'], [other.token, 'other.txt']] as const) {
      expect((await upload(gateway, token, name, 'fixture')).status).toBe(200)
      expect((await call(gateway, '/api/stories/' + name + '/preparation', token, 'POST')).status).toBe(202)
    }
    const order: string[] = []
    const storage = createHttpServer((req, res) => {
      order.push(req.url?.split('/stories/')[1]?.split('/')[0] ?? '')
      res.writeHead(503).end()
    })
    await new Promise<void>((resolve) => { storage.listen(0, '127.0.0.1', resolve) })
    const address = storage.address()
    if (!address || typeof address === 'string') throw new Error('could not open storage fault fixture')
    const worker = startProcess('src/workers/storyPreparation.ts', 'fair-worker', 'http://127.0.0.1:' + address.port, true)
    try {
      await expect.poll(() => order.length, { timeout: 12_000 }).toBe(3)
      expect(order).toEqual([String(owner.user.id), String(other.user.id), String(owner.user.id)])
    } finally {
      await stopProcess(worker)
      storage.closeAllConnections()
      await new Promise<void>((resolve) => { storage.close(() => resolve()) })
    }
  }, 30_000)


  it.skipIf(!canInjectStorageFault).each(['cancel', 'timeout'] as const)(
    'keeps the last ready revision when a worker is held at final storage verification (%s)',
    async (interruption) => {
      const gateway = await startGateway(await freePort(), 'publish-fence-' + interruption, undefined, true)
      const owner = await account(gateway)
      const fixture = await readFile(new URL('../../../e2e/fixtures/demo-story.txt', import.meta.url), 'utf8')
      expect((await upload(gateway, owner.token, 'fence.txt', fixture)).status).toBe(200)
      const route = '/api/stories/fence.txt/preparation'
      const seedWorker = startProcess('src/workers/storyPreparation.ts', 'seed-fence-' + interruption, undefined, true)
      try {
        expect((await call(gateway, route, owner.token, 'POST')).status).toBe(202)
        await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.state, { timeout: 12_000 }).toBe('complete')
      } finally {
        await stopProcess(seedWorker)
      }
      const before = (await call(gateway, route, owner.token)).body.activeRevision
      const publisher = interruption === 'timeout'
        ? await startGateway(await freePort(), 'short-deadline', undefined, true, { STORY_PREPARATION_DEADLINE_MS: '12000' })
        : gateway

      let releaseHead: (() => void) | undefined
      const nextRead = Promise.withResolvers<void>()
      const { endpoint } = fixtureObjectStore
      const storage = createHttpServer((req, res) => {
        const url = new URL(req.url!, endpoint)
        const forward = () => {
          const upstream = proxyRequest(url, { method: req.method, headers: req.headers }, (reply) => {
            res.writeHead(reply.statusCode ?? 502, reply.headers)
            reply.pipe(res)
          })
          upstream.on('error', () => res.writeHead(502).end())
          req.pipe(upstream)
        }
        if (req.method === 'HEAD' && url.pathname.endsWith('/gaps') && !releaseHead) {
          releaseHead = forward
          return
        }
        if (req.method === 'GET' && releaseHead) nextRead.resolve()
        forward()
      })
      await new Promise<void>((resolve) => { storage.listen(0, '127.0.0.1', resolve) })
      const address = storage.address()
      if (!address || typeof address === 'string') throw new Error('could not open storage fault fixture')
      const late = startProcess('src/workers/storyPreparation.ts', 'late-fence-' + interruption,
        'http://127.0.0.1:' + address.port, true, undefined, { STORY_PREPARATION_LEASE_MS: '15000' })
      try {
        const queued = await call(publisher, route, owner.token, 'POST')
        expect(queued.status).toBe(202)
        await expect.poll(() => Boolean(releaseHead), { timeout: 10_000 }).toBe(true)
        expect((await call(gateway, route, owner.token)).body.job?.stage).toBe('publish')
        if (interruption === 'cancel') {
          const cancelled = await call(gateway, route + '/' + queued.body.job.id + '/cancel', owner.token, 'POST')
          expect(cancelled.status).toBe(200)
        } else {
          await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.stage, { timeout: 15_000 }).toBe('timed_out')
        }
        releaseHead!()
        expect((await upload(gateway, owner.token, 'advance.txt', 'different story')).status).toBe(200)
        expect((await call(gateway, '/api/stories/advance.txt/preparation', owner.token, 'POST')).status).toBe(202)
        await Promise.race([nextRead.promise, delay(8_000, undefined, { ref: false }).then(() => { throw new Error('worker did not leave the expired attempt') })])
        expect((await call(gateway, route, owner.token)).body).toMatchObject({
          activeRevision: before,
          job: { id: queued.body.job.id, stage: interruption === 'cancel' ? 'cancelled' : 'timed_out' },
        })
        expect((await loadActivePreparedStory(owner.user.id, 'fence.txt', AbortSignal.timeout(5_000))).revision).toBe(before)
        await call(gateway, '/api/stories/advance.txt', owner.token, 'DELETE')
      } finally {
        await stopProcess(late)
        storage.closeAllConnections()
        await new Promise<void>((resolve) => { storage.close(() => resolve()) })
      }
    }, 65_000,
  )

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
      await expect.poll(async () => (await call(gateway, route, owner.token)).body.job?.state, { timeout: 25_000 }).toBe('failed')
      expect((await call(gateway, route, owner.token)).body).toEqual({
        activeRevision: null,
        job: { id: queued.body.job.id, version: expect.any(String), state: 'failed', stage: 'source_failed', percent: 5 },
      })
      expect((await call(gateway, '/api/rag/stories?limit=2', owner.token)).body.stories).toEqual([])
    } finally {
      await stopProcess(worker)
    }
  }, 55_000)
})
