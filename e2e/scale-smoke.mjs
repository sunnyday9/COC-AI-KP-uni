// Synthetic, single-host smoke. No provider calls, production data or remote targets.
// Run with Node 24+ using: node e2e/scale-smoke.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { migrateDatabase } from '../server/src/db/migrations.ts'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')
const root = fileURLToPath(new URL('..', import.meta.url))
const rooms = Number(process.env.SCALE_ROOMS ?? 128)
const stories = Number(process.env.SCALE_STORY_ROWS ?? 100_000)
const rounds = Number(process.env.SCALE_ROUNDS ?? 3)
const spreadMs = Number(process.env.SCALE_SPREAD_MS ?? 0)
const kpActiveTurns = 16
const kpChunkStream = false
assert(Number.isSafeInteger(rooms) && rooms >= 1 && rooms <= 10_000, 'SCALE_ROOMS must be in [1, 10000]')
assert(Number.isSafeInteger(stories) && stories >= 0 && stories <= 10_000_000, 'SCALE_STORY_ROWS must be in [0, 10000000]')
assert(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20, 'SCALE_ROUNDS must be in [1, 20]')
assert(Number.isSafeInteger(spreadMs) && spreadMs >= 0 && spreadMs <= 300_000, 'SCALE_SPREAD_MS must be in [0, 300000]')

const secret = randomUUID()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-scale-smoke-'))
const sockets = new Set()
const samples = []
let child
let serverTail = ''

function seed() {
  const db = new DatabaseSync(path.join(temp, 'ai-kp.db'))
  try {
    migrateDatabase(db)
    const addUser = db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'fixture', 0)")
    const addRoom = db.prepare(`
      INSERT INTO rooms (room_id, owner_id, invite_code, kind, phase, state, created_at, updated_at)
      VALUES (?, ?, ?, 'solo', 'playing', ?, 0, 0)
    `)
    const addMember = db.prepare("INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'owner')")
    // A previously opened room lets the test time player-triggered turns independently of joins.
    const state = JSON.stringify({
      seq: 1, phase: 'playing', turnWindowMs: 0,
      messages: [{ id: 'opening', role: 'kp', timestamp: 0, content: '调查已经开始。' }],
    })
    db.exec('BEGIN IMMEDIATE')
    for (let id = 1; id <= rooms; id++) {
      addUser.run(id, `player-${id}`)
      addRoom.run(`scale-${id}`, id, `fixture-${id}`, state)
      addMember.run(`scale-${id}`, id)
    }
    if (stories) db.prepare(`
      WITH RECURSIVE fixture(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM fixture WHERE i < ?)
      INSERT INTO stories (user_id, story_id, name, created_at)
      SELECT CASE WHEN i % 10 = 0 THEN 1 ELSE (i % ? + 1) END,
             'story-' || i || '.txt', 'Fixture ' || i, i
      FROM fixture
    `).run(stories, rooms)
    db.exec('COMMIT')
    return db.prepare('SELECT COUNT(*) AS count FROM stories WHERE user_id = 1').get().count
  } finally {
    db.close()
  }
}

async function start() {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  child = spawn(process.execPath, ['--import', 'tsx', 'server/src/app.ts'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), MOCK_AI: '1', JWT_SECRET: secret, LOG_LEVEL: 'warn',
      DATA_DIR: temp, UPLOADS_DIR: path.join(temp, 'uploads'),
      DOSSIER_DATA_DIR: path.join(temp, 'dossiers'), RAG_DATA_DIR: path.join(temp, 'rag'),
      MODELS_DIR: path.join(temp, 'models'), ROOM_ACTIVE_INSTANCES: String(rooms),
      KP_ACTIVE_TURNS: String(kpActiveTurns), KP_CHUNK_STREAM: kpChunkStream ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = (data) => { serverTail = (serverTail + data.toString()).slice(-6_000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 120; attempt++) {
    const ready = await fetch(`${base}/health/ready`, {
      headers: { Connection: 'close' }, signal: AbortSignal.timeout(500),
    }).catch(() => null)
    if (ready?.ok) return base
    assert(child.exitCode === null, 'server exited during startup')
    await delay(250)
  }
  throw new Error('server did not become ready')
}

function waitForFrame(socket, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', read)
      socket.off('close', closed)
    }
    const read = (data) => {
      const frame = JSON.parse(data.toString())
      if (!predicate(frame) && frame.type !== 'room:error') return
      cleanup()
      if (frame.type === 'room:error') reject(new Error(frame.error))
      else resolve(frame)
    }
    const closed = () => { cleanup(); reject(new Error('room socket closed')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('room frame timed out')) }, 60_000)
    socket.on('message', read)
    socket.once('close', closed)
  })
}

function token(id) {
  return jwt.sign({ sub: String(id) }, secret, { expiresIn: '15m' })
}

async function join(base, id) {
  const roomId = `scale-${id}`
  const socket = new WebSocket(`${base.replace(/^http:/, 'ws:')}/ws?token=${token(id)}`)
  sockets.add(socket)
  await once(socket, 'open')
  socket.on('error', () => socket.terminate())
  const joined = waitForFrame(socket, (frame) => frame.type === 'room:state')
  socket.send(JSON.stringify({ type: 'room:join', roomId }))
  assert.equal((await joined).snapshot.phase, 'playing')
  return { socket, roomId }
}

async function play({ socket, roomId }) {
  const started = performance.now()
  const message = (frame, role) => frame.eventType === 'message_appended' && frame.payload?.message?.role === role
  const echo = waitForFrame(socket, (frame) => message(frame, 'player')).then(() => performance.now() - started)
  const turn = waitForFrame(socket, (frame) => message(frame, 'kp')).then(() => performance.now() - started)
  socket.send(JSON.stringify({ type: 'room:action', roomId, action: { type: 'chat', payload: { content: '我观察四周。' } } }))
  const [echoMs, turnMs] = await Promise.all([echo, turn])
  return { echoMs, turnMs }
}

function p95(values) {
  values.sort((a, b) => a - b)
  return Math.round(values[Math.ceil(values.length * 0.95) - 1])
}

try {
  const catalogSize = seed()
  const base = await start()
  const clients = []
  for (let startId = 1; startId <= rooms; startId += 32) {
    const count = Math.min(32, rooms - startId + 1)
    clients.push(...await Promise.all(Array.from({ length: count }, (_, i) => join(base, startId + i))))
  }
  const catalog = async () => {
    const start = performance.now()
    const response = await fetch(`${base}/api/stories?limit=25`, {
      headers: { Authorization: `Bearer ${token(1)}`, Connection: 'close' },
      signal: AbortSignal.timeout(60_000),
    })
    assert.equal(response.status, 200)
    const page = await response.json()
    assert.equal(page.stories.length, Math.min(25, catalogSize))
    return performance.now() - start
  }
  const catalogMs = []
  for (let round = 0; round < rounds; round++) {
    const turns = clients.map(async (client, i) => {
      if (spreadMs > 0) await delay(Math.floor(i * spreadMs / rooms))
      return play(client)
    })
    const [measurements, listMs] = await Promise.all([Promise.all(turns), catalog()])
    samples.push(...measurements)
    catalogMs.push(listMs)
  }
  console.log(JSON.stringify({
    mode: 'single-host MOCK_AI', rooms, storyMetadataRows: stories, rounds, spreadMs,
    kpActiveTurns, kpChunkStream, completedTurns: samples.length,
    playerEchoP95Ms: p95(samples.map((result) => result.echoMs)),
    kpReplyP95Ms: p95(samples.map((result) => result.turnMs)),
    catalogPageP95Ms: p95(catalogMs),
  }, null, 2))
} catch (error) {
  console.error(error, serverTail)
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.terminate()
  if (child?.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit')
    child.kill()
    await stopped
  }
  fs.rmSync(temp, { recursive: true, force: true })
}
