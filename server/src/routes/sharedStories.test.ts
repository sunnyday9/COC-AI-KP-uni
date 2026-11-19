import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseUrl = process.env.TEST_SHARED_STORIES_DATABASE_URL
const s3Fixture = process.env.TEST_SHARED_STORIES_S3
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

async function startGateway(port: number, dir: string, endpointOverride?: string): Promise<string> {
  const objectStore = JSON.parse(s3Fixture!)
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    env: {
      ...process.env,
      TEST_SHARED_STORIES_DATABASE_URL: undefined,
      TEST_SHARED_STORIES_S3: undefined,
      DEPLOYMENT_MODE: 'shared-accounts',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: secret,
      NODE_ENV: 'production',
      PORT: String(port),
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
  })
  children.push(child)
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

function upload(url: string, token: string, name: string, content: string) {
  const form = new FormData()
  form.append('file', new Blob([content]), name)
  return call(url, '/api/stories/upload', token, 'POST', form)
}

describe.skipIf(!databaseUrl || !s3Fixture)('private story catalog over two HTTP gateways', () => {
  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'aikp-shared-story-http-'))
    const firstPort = await freePort()
    const secondPort = await freePort()
    const gateways = await Promise.all([startGateway(firstPort, 'first'), startGateway(secondPort, 'second')])
    first = gateways[0]
    second = gateways[1]
  }, 25_000)

  afterAll(async () => {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      return new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
      })
    }))
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

})
