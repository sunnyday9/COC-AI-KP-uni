import { spawn, type ChildProcess } from 'node:child_process'
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

const databaseUrl = process.env.TEST_SHARED_ACCOUNTS_DATABASE_URL
const jwtSecret = randomBytes(32).toString('hex')
const password = randomBytes(15).toString('hex')

interface Gateway {
  child: ChildProcess
  url: string
  storageDir: string
  logs: string
}

const gateways: Gateway[] = []
const storageDirs = new Set<string>()

async function stopGateway(gateway: Gateway): Promise<void> {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    gateway.child.once('exit', () => resolve())
    gateway.child.kill()
  })
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(stopGateway))
  await Promise.all([...storageDirs].map((dir) => rm(dir, { recursive: true, force: true })))
  storageDirs.clear()
})

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        return reject(new Error('could not reserve a TCP port'))
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function launchGateway(options: { restart?: Gateway; local?: boolean; database?: string } = {}): Promise<Gateway> {
  const dataDir = options.restart?.storageDir ?? await mkdtemp(join(tmpdir(), 'aikp-accounts-http-'))
  storageDirs.add(dataDir)
  const listenPort = options.restart ? Number(new URL(options.restart.url).port) : await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    env: {
      ...process.env,
      TEST_SHARED_ACCOUNTS_DATABASE_URL: undefined,
      DEPLOYMENT_MODE: options.local ? 'local' : 'shared-accounts',
      DATABASE_URL: options.database ?? databaseUrl,
      DATA_DIR: dataDir,
      JWT_SECRET: jwtSecret,
      NODE_ENV: 'production',
      PORT: String(listenPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const gateway = { child, url: `http://127.0.0.1:${listenPort}`, storageDir: dataDir, logs: '' }
  gateways.push(gateway)
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()) })
  child.stdout.on('data', (chunk: Buffer) => { gateway.logs += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { gateway.logs += chunk.toString() })

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await closed
      throw new Error('gateway exited during startup')
    }
    const response = await fetch(`${gateway.url}/health/ready`, { signal: AbortSignal.timeout(1_000) }).catch(() => null)
    if (response?.ok) return gateway
    await delay(100)
  }
  throw new Error('gateway never became ready')
}

async function call(gateway: Gateway, path: string, method = 'GET', token?: string, payload?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${gateway.url}${path}`, {
    method, headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000),
  })
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!databaseUrl)('shared accounts over two HTTP gateways', () => {
  it('accepts a registration and token across gateways and after restarting a gateway', async () => {
    const [first, second] = await Promise.all([launchGateway(), launchGateway()])
    const credentials = { username: randomUUID().slice(0, 24), password }
    const registration = await call(first, '/api/auth/register', 'POST', undefined, credentials)
    expect(registration.status).toBe(200)
    const { token, user } = registration.body
    expect(user).toEqual({ id: expect.any(Number), username: credentials.username })
    expect(typeof token).toBe('string')

    const login = await call(second, '/api/auth/login', 'POST', undefined, credentials)
    expect(login.status).toBe(200)
    expect(login.body.user).toEqual(user)
    expect(await call(second, '/api/auth/me', 'GET', token)).toEqual({ status: 200, body: { user } })

    await stopGateway(first)
    const restarted = await launchGateway({ restart: first })
    expect(await call(restarted, '/api/auth/me', 'GET', login.body.token)).toEqual({ status: 200, body: { user } })
    expect((await call(restarted, '/api/auth/login', 'POST', undefined, credentials)).body.user).toEqual(user)
  }, 45_000)

  it('reads and merges private account settings across gateways and a restart', async () => {
    const [first, second] = await Promise.all([launchGateway(), launchGateway()])
    const firstAccount = await call(first, '/api/auth/register', 'POST', undefined, { username: randomUUID().slice(0, 24), password })
    const secondAccount = await call(second, '/api/auth/register', 'POST', undefined, { username: randomUUID().slice(0, 24), password })
    const token = firstAccount.body.token
    const otherToken = secondAccount.body.token
    expect(firstAccount.status).toBe(200)
    expect(secondAccount.status).toBe(200)
    expect(firstAccount.body.user.id).not.toBe(secondAccount.body.user.id)

    const defaults = {
      ai: { protocol: 'openai_chat', baseUrl: '', model: '', temperature: 0.7, maxTokens: 2048 },
      rag: { useEmbeddings: true, provider: 'builtin', model: 'text-embedding-3-small', supplement: true },
    }
    expect(await call(second, '/api/settings', 'GET', token)).toEqual({ status: 200, body: defaults })
    const apiKey = randomBytes(24).toString('hex')
    const writes = await Promise.all([
      call(first, '/api/settings', 'PUT', token, {
        ai: { apiKey, protocol: 'openai_responses', model: 'first-account-model' },
      }),
      call(second, '/api/settings', 'PUT', token, { rag: { supplement: false } }),
    ])
    expect(writes).toEqual([{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }])
    expect(await call(second, '/api/settings', 'PUT', token, { ai: { apiKey: '***', maxTokens: 1024 } }))
      .toEqual({ status: 200, body: { ok: true } })
    expect(await call(first, '/api/settings', 'PUT', token, { ai: { temperature: 0.5 } }))
      .toEqual({ status: 200, body: { ok: true } })
    expect(await call(first, '/api/settings', 'PUT', token, { ai: { protocol: 'invalid', apiKey } }))
      .toEqual({ status: 400, body: { error: 'invalid protocol' } })
    expect(await call(first, '/api/settings', 'GET', otherToken)).toEqual({ status: 200, body: defaults })
    expect((await call(second, '/api/settings')).status).toBe(401)
    expect((await call(second, '/api/settings', 'GET', 'invalid-token')).status).toBe(401)

    await stopGateway(first)
    const restarted = await launchGateway({ restart: first })
    const persisted = await call(restarted, '/api/settings', 'GET', token)
    expect(persisted).toEqual({
      status: 200,
      body: {
        ai: { ...defaults.ai, protocol: 'openai_responses', model: 'first-account-model', temperature: 0.5, maxTokens: 1024 },
        rag: { ...defaults.rag, supplement: false },
      },
    })
    expect(JSON.stringify(persisted).includes(apiKey)).toBe(false)
    expect(gateways.some((gateway) => gateway.logs.includes(apiKey))).toBe(false)

    // Requests are black-box HTTP. The disposable fixture is read directly
    // here to verify encryption at rest, which the API cannot expose.
    const db = new Pool({ connectionString: databaseUrl })
    try {
      const result = await db.query<{ data: string }>('SELECT data FROM settings WHERE user_id = $1', [firstAccount.body.user.id])
      const stored = result.rows[0].data
      expect(stored.includes(apiKey)).toBe(false)
      const encrypted = JSON.parse(stored).ai.apiKey
      const validEnvelope = encrypted?.v === 1 && [encrypted.iv, encrypted.tag, encrypted.data].every((part) => typeof part === 'string')
      expect(validEnvelope).toBe(true)
      const key = createHash('sha256').update(jwtSecret).digest()
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8')
      expect(plain === apiKey).toBe(true)
    } finally {
      await db.end()
    }
  }, 45_000)

  it('creates one account when both gateways race to register the same username', async () => {
    const [first, second] = await Promise.all([launchGateway(), launchGateway()])
    const username = randomUUID().slice(0, 24)
    const otherPassword = randomBytes(15).toString('hex')
    const results = await Promise.all([
      call(first, '/api/auth/register', 'POST', undefined, { username, password }),
      call(second, '/api/auth/register', 'POST', undefined, { username, password: otherPassword }),
    ])
    expect(results.map((response) => response.status).sort()).toEqual([200, 409])
    const winner = results.findIndex((response) => response.status === 200)
    expect(results[1 - winner]).toEqual({ status: 409, body: { error: 'username already taken' } })
    const winningPassword = winner === 0 ? password : otherPassword
    const losingPassword = winner === 0 ? otherPassword : password
    const login = await call(second, '/api/auth/login', 'POST', undefined, { username, password: winningPassword })
    expect(login.status).toBe(200)
    expect(login.body.user).toEqual(results[winner].body.user)
    expect((await call(first, '/api/auth/login', 'POST', undefined, { username, password: losingPassword })).status).toBe(401)
  }, 45_000)

  it('rejects tokens minted by the other deployment mode under the same signing secret', async () => {
    const [shared, local] = await Promise.all([launchGateway(), launchGateway({ local: true })])
    const credentials = { username: randomUUID().slice(0, 24), password }
    const accounts = await Promise.all([
      call(shared, '/api/auth/register', 'POST', undefined, credentials),
      call(local, '/api/auth/register', 'POST', undefined, credentials),
    ])
    expect(accounts.map((response) => response.status)).toEqual([200, 200])
    expect((await call(local, '/api/settings', 'GET', accounts[0].body.token)).status).toBe(401)
    expect((await call(shared, '/api/settings', 'GET', accounts[1].body.token)).status).toBe(401)
  }, 45_000)

  it('responds with a client error on register and login with an embedded null in the username', async () => {
    const [first, second] = await Promise.all([launchGateway(), launchGateway()])
    const credentials = { username: 'embedded\u0000null', password }
    const responses = await Promise.all([
      call(first, '/api/auth/register', 'POST', undefined, credentials),
      call(second, '/api/auth/login', 'POST', undefined, credentials),
    ])
    const invalid = { status: 400, body: { error: 'username must not contain a null character' } }
    expect(responses).toEqual([invalid, invalid])
  }, 45_000)

  it('fails before listening when a pre-existing shared account schema is incompatible', async () => {
    const schema = `incompatible_${randomUUID().replaceAll('-', '')}`
    const db = new Pool({ connectionString: databaseUrl })
    try {
      // The only SQL identifier is generated from a fixed prefix and UUID hex.
      await db.query(`CREATE SCHEMA ${schema}`)
      await db.query(`
        CREATE TABLE ${schema}.users (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          username TEXT COLLATE "C" NOT NULL,
          password_hash TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )
      `)
      const url = new URL(databaseUrl!)
      url.searchParams.set('options', `-c search_path=${schema}`)
      await expect(launchGateway({ database: url.toString() })).rejects.toThrow('gateway exited during startup')
      expect(gateways.at(-1)?.logs.includes('Incompatible PostgreSQL account/settings schema')).toBe(true)
      expect(gateways.at(-1)?.logs.includes('server listening')).toBe(false)
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await db.end()
    }
  }, 45_000)
})
