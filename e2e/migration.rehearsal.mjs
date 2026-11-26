import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import { WebSocket } from 'ws'
import {
  GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { migrateDatabase } from '../server/src/db/migrations.ts'
import { chunkStoryText } from '../server/src/rag/chunker.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-migration-'))
const source = path.join(temp, 'source')
const frozen = path.join(temp, 'sqlite-backup')
const password = 'fictitious-investigator-password'
const original = 'Archive corridor and listening post. Brass lamps illuminate the footprints along the western wall.\n\n' +
  'Hidden vault. The local archivist installed the beacon underneath the stone stairs. The brass key opens the vault door.'
const legacyOriginal = '\uFEFF \n' + original + '\n \n'
const storyId = 'fixture-archive.txt'
const localRevision = 'b926c123-1f15-4317-ae6c-973038aabae0'
const newerStory = 'fixture-tower.txt'
const postWrite = 'I examine the archive ledger after cutover.'
const queued = 'I search the old locker before cutover.'
const secret = randomBytes(32).toString('hex')
const migratedKey = 'fictional-byok-key'
const db = new URL(process.env.MIGRATION_FIXTURE_DB)
const restoredDb = new URL(process.env.MIGRATION_RESTORE_DB)
const endpoint = new URL(process.env.STORY_S3_ENDPOINT)
const bucket = process.env.STORY_S3_BUCKET
const restoredBucket = process.env.MIGRATION_RESTORE_BUCKET
const port = Number(process.env.MIGRATION_APP_PORT ?? 19425)
const base = `http://127.0.0.1:${port}`
const restoredPort = port + 1
const sockets = new Set()
let app
let appLog
const sourceEnv = (dir) => ({
  DATA_DIR: path.join(dir, 'data'), UPLOADS_DIR: path.join(dir, 'uploads'),
  RAG_DATA_DIR: path.join(dir, 'rag'), DOSSIER_DATA_DIR: path.join(dir, 'dossiers'),
})
const sharedEnv = (url, name, appPort) => ({
  ...process.env, ...sourceEnv(frozen), DATABASE_URL: url.href, STORY_S3_BUCKET: name,
  JWT_SECRET: secret, DEPLOYMENT_MODE: 'shared-accounts', ENABLE_SHARED_ROOMS: '1', STORY_PREPARATION_ENABLED: '1',
  ENABLE_ROOM_WORKER_FAILOVER: '1', ROOM_RUNTIME: 'direct', ROOM_WORKER_LEASE_MS: '15000', MOCK_AI: '1',
  PORT: String(appPort), NODE_ENV: 'test',
})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function file(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, bytes, { mode: 0o600 })
}

async function seed() {
  process.env.JWT_SECRET = secret
  const { computeCoverageGaps, GAPS_VERSION } = await import('../server/src/rag/dossier/coverageGaps.ts')
  const { encryptSecret } = await import('../server/src/utils/crypto.ts')
  fs.mkdirSync(path.join(source, 'data'), { recursive: true })
  const sqlite = new DatabaseSync(path.join(source, 'data', 'ai-kp.db'))
  migrateDatabase(sqlite)
  const now = 1_700_000_000_000
  const passwordHash = await bcrypt.hash(password, 4)
  const insertUser = sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)')
  insertUser.run(17, 'archivist', passwordHash, now)
  insertUser.run(42, 'successor', passwordHash, now)
  insertUser.run(83, 'observer', passwordHash, now)
  sqlite.exec('UPDATE sqlite_sequence SET seq = 100 WHERE name = \'users\'')
  const settings = JSON.stringify({ ai: { model: 'fixture-archivist', apiKey: encryptSecret(migratedKey) } })
  sqlite.prepare('INSERT INTO settings VALUES (?, ?)').run(17, settings)
  const insertStory = sqlite.prepare('INSERT INTO stories (user_id, story_id, name, file_path, created_at) VALUES (?, ?, ?, ?, ?)')
  insertStory.run(17, newerStory, newerStory, '741c2976-cd69-44d2-acbd-b04004c64798.txt', now)
  const directory = path.join(source, 'uploads', '17', 'stories')
  file(path.join(directory, storyId), legacyOriginal)
  file(path.join(directory, '741c2976-cd69-44d2-acbd-b04004c64798.txt'), original)
  file(path.join(directory, 'fixture-unprepared.txt'), 'Fictional source only.')
  for (const [id, revision, fileStem] of [[storyId, undefined, 'legacy-archive'], [newerStory, localRevision, '741c2976-cd69-44d2-acbd-b04004c64798']]) {
    const scenes = [{ id: 'vault', name: 'Hidden vault', sceneText: original }]
    const dossier = { scriptId: id, storyName: id, generatedAt: now, sourceRevision: revision,
      scenes, clues: [], npcs: [], truths: [{ title: 'Beacon', detail: 'The archivist installed it.', revealScene: 'vault' }] }
    const gaps = { ...computeCoverageGaps(original, scenes), gapsVersion: GAPS_VERSION, scriptId: id, storyName: id,
      generatedAt: now, sourceRevision: revision }
    const chunks = chunkStoryText(revision ? original : legacyOriginal)
    const index = { scriptId: id, storyName: id, indexedAt: now, chunkCount: chunks.length, idf: [],
      docs: chunks.map(({ content, start }, index) => ({
        id: String(index), content, type: 'paragraph', metadata: { start, storyId: id }, tf: [], tfidf: [],
      })) }
    const data = path.join(source, 'dossiers', '17')
    file(path.join(data, fileStem + '.json'), JSON.stringify(dossier, null, 2))
    file(path.join(data, fileStem + '.gaps.json'), JSON.stringify(gaps, null, 2))
    file(path.join(source, 'rag', '17', 'rag_index', fileStem + '.json'), JSON.stringify(index, null, 2))
    if (!revision) file(path.join(data, fileStem + '.annex.json'), JSON.stringify({ scriptId: id, images: [] }))
  }
  const roster = sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?, ?, ?)')
  for (const [id, owner, playerName] of [['char-a', 17, 'Archivist'], ['char-b', 42, 'Successor']]) {
    const sheet = {
      playerName, occupationName: 'Archivist', skills: {},
      attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
      derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 50 },
    }
    roster.run(id, owner, playerName, JSON.stringify(sheet), now)
  }
  const history = Array.from({ length: 130 }, (_, i) => ({
    id: `message-${i + 1}`, timestamp: now + i, role: 'kp', content: `Synthetic transcript entry ${i + 1}`,
  }))
  history.push({ id: 'queued-message', timestamp: now + history.length, role: 'player', content: queued })
  const saved = { seq: 271, storyId, phase: 'playing', messages: history, characters: {}, clues: [], scene: null,
    ending: null, kpSetupRequired: true, openingCheckpointed: true, turnWindowMs: 0, updatedAt: now,
    pendingPlayerTurn: { id: 'legacy-turn', actionCount: 1 },
    pendingTurnMessages: [{ username: 'successor', content: queued, characterId: 'char-b',
      authorUserId: 42, actionId: 'legacy-action', messageId: 'queued-message' }] }
  const insertRoom = sqlite.prepare(`INSERT INTO rooms
    (room_id, owner_id, invite_code, story_id, phase, state, version, updated_at, created_at, kind, story_owner_id)
    VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?)`)
  insertRoom.run('fixture-multi', 42, 'TEST42', storyId, 'playing', JSON.stringify(saved), now, now, 'multi', 17)
  insertRoom.run('fixture-solo', 17, 'TEST17', newerStory, 'playing', JSON.stringify({
    ...saved, storyId: newerStory, messages: [history[0]], seq: 2, kpSetupRequired: false,
    pendingPlayerTurn: undefined, pendingTurnMessages: [],
  }), now, now, 'solo', 17)
  const member = sqlite.prepare('INSERT INTO room_members VALUES (?, ?, ?, ?, ?)')
  member.run('fixture-multi', 83, 'member', null, 0)
  member.run('fixture-multi', 17, 'member', 'char-a', 1)
  member.run('fixture-multi', 42, 'owner', 'char-b', 1)
  member.run('fixture-solo', 17, 'owner', 'char-a', 1)
  const receipt = sqlite.prepare('INSERT INTO room_actions VALUES (?, ?, ?, ?, ?, ?)')
  receipt.run('fixture-multi', 42, 'legacy-action', hash(JSON.stringify(['chat', queued])), 'queued-message', 'pending')
  receipt.run('fixture-multi', 17, 'legacy-completed', hash(JSON.stringify(['chat', 'earlier'])), 'message-1', 'completed')
  receipt.run('fixture-multi', 83, 'legacy-cancelled', hash(JSON.stringify(['chat', 'cancelled'])), 'old-cancelled', 'cancelled')
  sqlite.close()
  fs.cpSync(source, frozen, { recursive: true, preserveTimestamps: true })
  return { settings, history }
}

async function command(executable, args, { env = process.env, input, binary = false } = {}) {
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []
  const diag = []
  child.stdout.on('data', data => output.push(data))
  child.stderr.on('data', data => diag.push(data))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const [code] = await once(child, 'close')
  return { code, output: binary ? Buffer.concat(output) : Buffer.concat(output).toString(), diag: Buffer.concat(diag).toString() }
}

function migrate(env = sharedEnv(db, bucket, port)) {
  return command(process.execPath, ['--import', 'tsx', 'server/src/migration/importSqlite.ts', '--offline'], { env })
}

function pgCommand(name, url, args, input) {
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }
  const connection = ['-h', url.hostname, '-p', url.port, '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1)]
  const wsl = process.env.MIGRATION_PG_WSL_ROOT
  if (wsl) {
    env.WSLENV = [env.WSLENV, 'PGPASSWORD/u'].filter(Boolean).join(':')
    return command('wsl.exe', ['--', 'env', `LD_LIBRARY_PATH=${wsl}/runtime/usr/lib/x86_64-linux-gnu`,
      `${wsl}/runtime/usr/lib/postgresql/16/bin/${name}`, ...connection, ...args], { env, input, binary: true })
  }
  return command(name, [...connection, ...args], { env, input, binary: true })
}

async function checkpoint(label, s3) {
  const dump = await pgCommand('pg_dump', db, ['-Fc', '--no-owner', '--no-privileges'])
  assert.equal(dump.code, 0, dump.diag)
  assert.equal(dump.output.subarray(0, 5).toString(), 'PGDMP')
  const dumpFile = path.join(temp, label, 'database.dump')
  file(dumpFile, dump.output)
  const objects = []
  let token
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
    for (const entry of page.Contents ?? []) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: entry.Key }))
      const bytes = Buffer.from(await response.Body.transformToByteArray())
      const digest = hash(bytes)
      assert.equal(bytes.length, entry.Size)
      file(path.join(temp, label, 'objects', digest), bytes)
      objects.push({ key: entry.Key, digest, bytes: bytes.length, metadata: response.Metadata })
    }
    token = page.NextContinuationToken
  } while (token)
  file(path.join(temp, label, 'objects.json'), JSON.stringify(objects))
  return { dumpFile, objects, label }
}

async function restore(checkpoint, s3) {
  for (const { key, digest, bytes, metadata } of checkpoint.objects) {
    const body = fs.readFileSync(path.join(temp, checkpoint.label, 'objects', digest))
    assert.equal(hash(body), digest)
    await s3.send(new PutObjectCommand({ Bucket: restoredBucket, Key: key,
      Body: body, ContentLength: bytes, IfNoneMatch: '*', Metadata: metadata }))
    const uploaded = await s3.send(new GetObjectCommand({ Bucket: restoredBucket, Key: key }))
    assert.equal(hash(Buffer.from(await uploaded.Body.transformToByteArray())), digest)
  }
  const result = await pgCommand('pg_restore', restoredDb, ['--exit-on-error', '--no-owner', '--no-privileges'],
    fs.readFileSync(checkpoint.dumpFile))
  assert.equal(result.code, 0, result.diag)
}

async function runApp(url, name, appPort) {
  appLog = []
  app = spawn(process.execPath, ['--import', 'tsx', 'server/src/app.ts'], {
    cwd: root, env: sharedEnv(url, name, appPort), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', data => appLog.push(data.toString()))
  app.stderr.on('data', data => appLog.push(data.toString()))
  for (let attempt = 0; attempt < 120; attempt++) {
    if (app.exitCode !== null || app.signalCode !== null) break
    const response = await fetch(`http://127.0.0.1:${appPort}/health/ready`, { signal: AbortSignal.timeout(1000) }).catch(() => null)
    if (response?.ok) return
    await delay(250)
  }
  throw new Error('Fixture app did not become ready: ' + appLog.slice(-12).join(''))
}

async function stopApp() {
  if (app?.exitCode === null && app.signalCode === null) {
    const stopped = once(app, 'exit')
    app.kill()
    await stopped
  }
  for (const socket of sockets) socket.terminate()
  sockets.clear()
}

function waitFrame(socket, predicate) {
  return new Promise((resolve, reject) => {
    function finish() {
      clearTimeout(timer)
      socket.off('message', frame)
      socket.off('close', closed)
    }
    function frame(bytes) {
      const data = JSON.parse(bytes.toString())
      if (data.type === 'room:error' || predicate(data)) {
        finish()
        if (data.type === 'room:error') reject(new Error(data.error))
        else resolve(data)
      }
    }
    function closed() {
      finish()
      reject(new Error('Fixture socket closed'))
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('Fixture socket did not receive the expected frame'))
    }, 20_000)
    socket.on('message', frame)
    socket.once('close', closed)
  })
}

async function json(baseUrl, route, { token, method = 'GET', data } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const body = data instanceof FormData ? data : data === undefined ? undefined : JSON.stringify(data)
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(baseUrl + route, { method, body, headers, signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200, route)
  return response.json()
}

function login(baseUrl, username) {
  return json(baseUrl, '/api/auth/login', { method: 'POST', data: { username, password } })
}

async function join(baseUrl, token, roomId) {
  const socket = new WebSocket(`${baseUrl.replace(/^http:/, 'ws:')}/ws?token=${token}`)
  sockets.add(socket)
  await once(socket, 'open')
  const snapshot = waitFrame(socket, frame => frame.type === 'room:state')
  socket.send(JSON.stringify({ type: 'room:join', roomId, lastSeq: 1 }))
  return { socket, state: await snapshot }
}

function sendAction(socket, roomId, actionId, content) {
  const receipt = waitFrame(socket, frame => frame.type === 'room:action:result' && frame.actionId === actionId)
  socket.send(JSON.stringify({ type: 'room:action', roomId, actionId, action: { type: 'chat', payload: { content } } }))
  return receipt
}


async function inspectRoom(baseUrl, token, history) {
  const room = await json(baseUrl, '/api/rooms/fixture-multi', { token })
  assert.equal(room.ownerId, 42)
  assert.equal(room.storyId, storyId)
  assert.equal(room.inviteCode, 'TEST42')
  assert.deepEqual(room.members.sort((left, right) => left.userId - right.userId)
    .map(({ userId, role, characterId, ready }) => [userId, role, characterId, ready]),
    [[17, 'member', 'char-a', true], [42, 'owner', 'char-b', true], [83, 'member', null, false]])
  assert.ok(room.state.messages.length <= 40)
  const originalHistory = []
  let before
  do {
    const url = new URL('/api/rooms/fixture-multi/history', baseUrl)
    url.searchParams.set('limit', '33')
    if (before) url.searchParams.set('before', before)
    const page = await json(baseUrl, url.pathname + url.search, { token })
    originalHistory.unshift(...page.messages)
    before = page.nextBefore
  } while (before)
  assert.deepEqual(originalHistory.slice(0, history.length), history)
  return originalHistory
}

async function completed(pool, actionId) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rows: [receipt] } = await pool.query('SELECT message_id, status FROM room_actions WHERE room_id = $1 AND action_id = $2',
      ['fixture-multi', actionId])
    if (receipt?.status === 'completed') return receipt.message_id
    await delay(150)
  }
  throw new Error('Fixture action did not complete: ' + actionId)
}

assert.equal(db.hostname, '127.0.0.1')
assert.equal(restoredDb.hostname, '127.0.0.1')
assert.equal(endpoint.hostname, '127.0.0.1')
assert.match(db.pathname, /^\/aikp_migration_/)
assert.match(restoredDb.pathname, /^\/aikp_migration_/)
assert.notEqual(db.href, restoredDb.href)
assert.match(bucket, /migration/)
assert.match(restoredBucket, /migration/)
assert.notEqual(bucket, restoredBucket)

const pool = new Pool({ connectionString: db.href, connectionTimeoutMillis: 5000 })
const s3 = new S3Client({
  endpoint: endpoint.href, region: process.env.STORY_S3_REGION, forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
})
try {
  for (const name of [bucket, restoredBucket]) {
    await s3.send(new HeadBucketCommand({ Bucket: name }))
    const existing = await s3.send(new ListObjectsV2Command({ Bucket: name, MaxKeys: 1 }))
    assert.equal(existing.KeyCount, 0, 'Use fresh fixture-only buckets')
  }

  const fixture = await seed()
  const sqliteBytes = hash(fs.readFileSync(path.join(frozen, 'data', 'ai-kp.db')))
  const badSecret = await migrate({ ...sharedEnv(db, bucket, port), JWT_SECRET: randomBytes(32).toString('hex') })
  assert.notEqual(badSecret.code, 0)
  assert.match(badSecret.diag, /Cannot decrypt a settings row/)
  const first = await migrate()
  assert.equal(first.code, 0, first.diag)
  const report = (await pool.query('SELECT reconciliation FROM sqlite_import')).rows[0].reconciliation
  assert.deepEqual(report.counts, {
    users: 3, settings: 1, characters: 2, story_catalog: 3, story_preparation_jobs: 2,
    story_preparation_revisions: 2, rooms: 2, room_members: 4, room_transcript: 132, room_actions: 3,
  })
  assert.deepEqual([report.pausedRooms, report.pendingActions, report.unpreparedStories.length, report.objects.length], [1, 1, 1, 18])
  const rerun = await migrate()
  assert.equal(rerun.code, 0, rerun.diag)
  assert.equal(rerun.output, first.output)
  const key = report.objects[0].key
  const savedObject = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const correct = Buffer.from(await savedObject.Body.transformToByteArray())
  const changed = Buffer.from(correct)
  changed[0] ^= 0xff
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: changed, Metadata: savedObject.Metadata }))
  const collision = await migrate()
  assert.notEqual(collision.code, 0)
  assert.match(collision.diag, /destination object checksum differs/)
  const unchanged = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  assert.deepEqual(Buffer.from(await unchanged.Body.transformToByteArray()), changed)
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: correct, Metadata: savedObject.Metadata }))
  assert.equal(hash(fs.readFileSync(path.join(frozen, 'data', 'ai-kp.db'))), sqliteBytes)
  const { rows: [paused] } = await pool.query(`SELECT owner_id, story_owner_id, state, event_seq, turn_pending,
    story_preparation_revision FROM rooms WHERE room_id = 'fixture-multi'`)
  const ordered = await pool.query("SELECT user_id FROM room_members WHERE room_id = 'fixture-multi' ORDER BY join_order")
  assert.deepEqual(ordered.rows.map(row => row.user_id), ['83', '17', '42'])
  assert.equal(paused.owner_id, '42')
  assert.equal(paused.story_owner_id, '17')
  assert.equal(paused.event_seq, '271')
  assert.equal(paused.turn_pending, false)
  assert.equal(JSON.parse(paused.state).kpSetupRequired, true)
  assert.equal(JSON.parse(paused.state).pendingPlayerTurn.id, 'legacy-turn')
  assert.equal((await pool.query("SELECT story_preparation_revision FROM rooms WHERE room_id = 'fixture-solo'")).rows[0]
    .story_preparation_revision, localRevision)
  assert.equal((await pool.query('SELECT data FROM settings WHERE user_id = 17')).rows[0].data, fixture.settings)

  const baseline = await checkpoint('before-cutover', s3)
  assert.equal(baseline.objects.length, report.objects.length)
  for (const sourceObject of report.objects) {
    const copied = baseline.objects.find(object => object.key === sourceObject.key)
    assert.equal(copied?.digest, sourceObject.sha256)
    assert.equal(copied?.bytes, sourceObject.size)
  }

  await runApp(db, bucket, port)
  const archivist = await login(base, 'archivist')
  const successor = await login(base, 'successor')
  assert.deepEqual([archivist.user.id, successor.user.id], [17, 42])
  const publicSettings = await json(base, '/api/settings', { token: archivist.token })
  assert.equal(publicSettings.ai.model, 'fixture-archivist')
  assert.equal(publicSettings.ai.apiKey, undefined)
  const sourceRoute = '/api/stories/' + encodeURIComponent(storyId) + '/source'
  const download = await fetch(base + sourceRoute, { headers: { Authorization: 'Bearer ' + archivist.token } })
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(legacyOriginal))
  const denied = await fetch(base + sourceRoute, { headers: { Authorization: 'Bearer ' + successor.token } })
  assert.equal(denied.status, 404)
  const anonymous = await fetch(endpoint.href.replace(/\/$/, '') + '/' + bucket + '/' + report.objects[0].key)
  assert.equal(anonymous.status, 403)
  assert.equal((await inspectRoom(base, successor.token, fixture.history)).length, fixture.history.length)

  const solo = await join(base, archivist.token, 'fixture-solo')
  assert.equal(solo.state.snapshot.phase, 'playing')
  const { socket, state } = await join(base, successor.token, 'fixture-multi')
  assert.equal(state.snapshot.phase, 'playing')
  assert.ok(state.snapshot.messages.length <= 40)
  const replayed = await sendAction(socket, 'fixture-multi', 'legacy-action', queued)
  assert.ok(['pending', 'completed'].includes(replayed.status))
  assert.equal(replayed.messageId, 'queued-message')
  socket.send(JSON.stringify({ type: 'room:action', roomId: 'fixture-multi', action: { type: 'retry_kp' } }))
  assert.equal(await completed(pool, 'legacy-action'), 'queued-message')
  const observer = await login(base, 'observer')
  const observerSocket = await join(base, observer.token, 'fixture-multi')
  const retired = await sendAction(observerSocket.socket, 'fixture-multi', 'legacy-cancelled', 'cancelled')
  assert.equal(retired.status, 'cancelled')
  const newReceipt = await sendAction(socket, 'fixture-multi', 'after-cutover', postWrite)
  assert.equal(newReceipt.status, 'pending')
  assert.equal(await completed(pool, 'after-cutover'), newReceipt.messageId)

  const newUser = await json(base, '/api/auth/register', { method: 'POST', data: { username: 'post-cutover', password } })
  assert.equal(newUser.user.id, 101)
  await json(base, '/api/settings', { token: newUser.token, method: 'PUT',
    data: { ai: { model: 'post-cutover-setting', apiKey: 'fictional-post-cutover-key' } } })
  const upload = new FormData()
  upload.set('file', new Blob(['Source bytes written after cutover.']), 'after-cutover.txt')
  const newStory = await json(base, '/api/stories/upload', { token: newUser.token, method: 'POST', data: upload })
  assert.equal(newStory.id, 'after-cutover.txt')
  await stopApp()

  const conflict = await migrate()
  assert.notEqual(conflict.code, 0)
  assert.match(conflict.diag, /Destination table .* contains writes outside this import|Destination table .* differs/)
  assert.equal(await completed(pool, 'after-cutover'), newReceipt.messageId)
  const after = await checkpoint('after-cutover', s3)
  assert.equal(after.objects.length, baseline.objects.length + 1)
  await restore(after, s3)

  // Roll back the application authority to a separately restored shared checkpoint.
  // SQLite remains frozen because the checkpoint includes new shared writes.
  await delay(15100)
  const restoredBase = `http://127.0.0.1:${restoredPort}`
  await runApp(restoredDb, restoredBucket, restoredPort)
  const restoredUser = await login(restoredBase, 'post-cutover')
  assert.equal(restoredUser.user.id, 101)
  const restoredSettings = await json(restoredBase, '/api/settings', { token: restoredUser.token })
  assert.equal(restoredSettings.ai.model, 'post-cutover-setting')
  const restoredStory = await fetch(restoredBase + '/api/stories/after-cutover.txt/source', {
    headers: { Authorization: 'Bearer ' + restoredUser.token },
  })
  assert.equal(restoredStory.status, 200)
  assert.equal(await restoredStory.text(), 'Source bytes written after cutover.')
  const restoredHost = await login(restoredBase, 'successor')
  const history = await inspectRoom(restoredBase, restoredHost.token, fixture.history)
  assert.equal(history.filter(message => message.id === 'queued-message').length, 1)
  assert.equal(history.filter(message => message.id === newReceipt.messageId && message.content === postWrite).length, 1)
  const restoredSocket = await join(restoredBase, restoredHost.token, 'fixture-multi')
  const duplicate = await sendAction(restoredSocket.socket, 'fixture-multi', 'after-cutover', postWrite)
  assert.equal(duplicate.status, 'completed')
  assert.equal(duplicate.messageId, newReceipt.messageId)
  assert.equal(hash(fs.readFileSync(path.join(frozen, 'data', 'ai-kp.db'))), sqliteBytes)

  console.log(JSON.stringify({ counts: report.counts, pendingActions: report.pendingActions, pausedRooms: report.pausedRooms,
    objectsBeforeCutover: baseline.objects.length, objectsAfterCutover: after.objects.length, restoredTranscriptMessages: history.length,
    idempotentRerun: true, conflictingRerunRejected: true, corruptObjectRejected: true, restoredNewWrites: true }, null, 2))
} catch (error) {
  console.error(error)
  if (appLog) console.error(appLog.slice(-20).join(''))
  process.exitCode = 1
} finally {
  await stopApp()
  await pool.end()
  s3.destroy()
  fs.rmSync(temp, { recursive: true, force: true })
}
