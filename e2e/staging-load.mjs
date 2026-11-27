// Synthetic shared-deployment load. See docs/scale-out-staging.md.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { seedAccounts, seedRooms, formats, source } from './staging/fixtures.mjs'
import { measureOffers, measureSubmissions, occupancy, referenceScorecard } from './staging/workload.mjs'

const require = createRequire(import.meta.url)
const { Pool } = require('pg')
const jwt = require('jsonwebtoken')
const WebSocket = require('ws')
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3')
const root = fileURLToPath(new URL('..', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')
const keeperFixture = new URL('./staging/keeper.mjs', import.meta.url).href
const profile = process.env.STAGING_PROFILE ?? 'local'
assert(['local', 'reference'].includes(profile), 'Unknown STAGING_PROFILE')
const reference = profile === 'reference'
const integer = (name, local, full, min, max) => {
  const value = Number(process.env['STAGING_' + name] ?? (reference ? full : local))
  assert(Number.isSafeInteger(value) && value >= min && value <= max, name + ' is out of range')
  return value
}
const config = {
  profile,
  seed: integer('SEED', 126, 126, 0, 2 ** 32 - 1),
  gateways: integer('GATEWAYS', 2, 6, 2, 12),
  roomWorkers: integer('ROOM_WORKERS', 2, 5, 2, 12),
  prepWorkers: integer('PREP_WORKERS', 1, 2, 1, 8),
  rooms: integer('ROOMS', 32, 2500, 4, 8000),
  multiRooms: integer('MULTI_ROOMS', 24, 2000, 0, 8000),
  idle: integer('IDLE', 8, 500, 0, 8000),
  owners: integer('OWNERS', 64, 5000, 2, 100_000),
  metadataRows: integer('METADATA', 5000, 3_000_000, 1, 10_000_000),
  largeLibrary: integer('LARGE_LIBRARY', 1000, 250_000, 1, 2_000_000),
  artifactsPerFormat: integer('ARTIFACTS_PER_FORMAT', 1, 40, 1, 200),
  warmupSec: integer('WARMUP_SEC', 3, 300, 0, 3600),
  pacedSec: integer('PACED_SEC', 18, 1800, 6, 7200),
  actionsPerSec: integer('ACTIONS_PER_SEC', 8, 100, 1, 1000),
  catalogPerSec: integer('CATALOG_PER_SEC', 4, 12, 1, 500),
  importPerMinute: integer('IMPORTS_PER_MINUTE', 2, 2, 0, 120),
  importBurst: integer('IMPORT_BURST', 3, 20, 0, 100),
  burst: integer('BURST', 16, 500, 0, 8000),
  reconnect: integer('RECONNECT', 12, 1000, 0, 10000),
  leaseMs: integer('LEASE_MS', 3000, 15000, 1000, 120000),
  joinConcurrency: integer('JOIN_CONCURRENCY', 24, 48, 1, 200),
  pgPoolMax: integer('PG_POOL_MAX', 10, 10, 2, 100),
}
assert(config.multiRooms <= config.rooms && config.largeLibrary <= config.metadataRows, 'Room and catalog fixture sizes disagree')
const totalSockets = config.rooms + config.multiRooms + config.idle
assert(config.reconnect <= config.rooms + config.multiRooms, 'Reconnect count exceeds playing clients')

// Restrict all externally provisioned dependencies to explicit scratch resources on IPv4 loopback.
const postgres = URL.parse(process.env.STAGING_DATABASE_URL ?? '')
assert(postgres && ['postgres:', 'postgresql:'].includes(postgres.protocol) &&
  postgres.hostname === '127.0.0.1' && postgres.port && !postgres.search && !postgres.hash &&
  /^\/stage126_[a-f0-9]{10}$/.test(postgres.pathname) && postgres.username === postgres.pathname.slice(1),
'Use the dedicated stage126 PostgreSQL database and same-named role on IPv4 loopback')
const objectStore = JSON.parse(process.env.STAGING_S3_FIXTURE ?? '{}')
const endpoint = URL.parse(objectStore.endpoint ?? '')
assert(endpoint?.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port &&
  endpoint.pathname === '/' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
  /^fixture-stage126-[a-f0-9]{10}$/.test(objectStore.bucket) && objectStore.forcePathStyle === true &&
  objectStore.region && objectStore.credentials?.accessKeyId && objectStore.credentials?.secretAccessKey,
'Use a dedicated stage126 object bucket on IPv4 loopback')
const output = path.resolve(process.env.STAGING_REPORT ?? 'staging-load-report.json')
const temp = await mkdtemp(path.join(os.tmpdir(), 'aikp-stage126-'))
const pool = new Pool({
  connectionString: postgres.href, application_name: 'staging-load-generator',
  max: 4, statement_timeout: 15000, connectionTimeoutMillis: 5000,
})
const s3 = new S3Client(objectStore)
const secret = randomBytes(32).toString('hex')
const metricsToken = randomBytes(32).toString('hex')
const token = (id) => jwt.sign({ sub: String(id), iss: 'aikp-shared-accounts' }, secret, { expiresIn: '4h' })
const children = new Set()
const gates = []
const workers = []
const clients = []
const assets = []
const imports = []
const actions = new Map()
const catalog = []
const reconnects = []
const failures = []
pool.on('error', (error) => failures.push({ phase: 'pool', code: errorTag(error) }))
const samples = []
const occupancySamples = []
const workload = { actual: {} }
const setup = []
const provider = []
const pacedTransports = { established: 0, unexpectedDrops: 0 }
const report = {
  config, totalSockets, node: process.version, started: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim(),
  host: { platform: os.platform(), logicalCpus: os.cpus().length, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  localOnly: true,
  scope: {
    placement: 'Generator and child processes share one host. PostgreSQL and S3 use IPv4 loopback endpoints.',
    dependencies: 'Dedicated synthetic PostgreSQL database and S3 bucket, deterministic Keeper, real preparation pipeline',
  },
}
const loop = monitorEventLoopDelay({ resolution: 20 })
let trafficStarted
let setupFailure
let sampling
let occupancyPhase

function errorTag(error) {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : error?.name
}

function percentile(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (p) => +(valid[Math.ceil(valid.length * p) - 1] ?? 0).toFixed(2)
  return valid.length ? { count: valid.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) } : { count: 0 }
}

async function until(test, limitMs, condition) {
  const ending = performance.now() + limitMs
  while (performance.now() < ending) {
    const value = await test()
    if (value) return value
    await delay(75)
  }
  throw Object.assign(new Error(condition), { code: condition })
}

async function batches(list, size, run) {
  for (let index = 0; index < list.length; index += size) {
    await Promise.all(list.slice(index, index + size).map(run))
  }
}

async function port() {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const n = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return n
}

async function start(role, index, priorPort) {
  const p = priorPort ?? await port()
  const entry = path.join(root, role === 'prep' ? 'server/src/workers/storyPreparation.ts' : 'server/src/app.ts')
  const processDirectory = path.join(temp, role + index)
  await mkdir(processDirectory, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|userprofile|appdata|localappdata|homedrive|homepath|home|comspec)$/i.test(key)))
  Object.assign(env, {
    NODE_ENV: 'production', DOTENV_CONFIG_PATH: path.join(temp, 'no-env-file'),
    PORT: String(p), DEPLOYMENT_MODE: 'shared-accounts', ROOM_RUNTIME: role === 'prep' ? 'direct' : role,
    ENABLE_SHARED_ROOMS: '1', ENABLE_ROOM_WORKER_FAILOVER: '1', ROOM_WORKER_LEASE_MS: String(config.leaseMs),
    STORY_PREPARATION_ENABLED: '1', DATABASE_URL: postgres.href,
    PGAPPNAME: 'staging-' + role + '-' + index, PG_POOL_MAX: String(config.pgPoolMax),
    STORY_S3_REGION: objectStore.region, STORY_S3_BUCKET: objectStore.bucket, STORY_S3_ENDPOINT: endpoint.href,
    STORY_S3_FORCE_PATH_STYLE: 'true', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_ACCESS_KEY_ID: objectStore.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: objectStore.credentials.secretAccessKey,
    AWS_SESSION_TOKEN: objectStore.credentials.sessionToken,
    JWT_SECRET: secret, MOCK_AI: '1', AIKP_SYNTHETIC_CHILD: '1', AIKP_FIXTURE_SEED: String(config.seed),
    DATA_DIR: path.join(temp, role + index, 'data'), RAG_DATA_DIR: path.join(temp, role + index, 'rag'),
    DOSSIER_DATA_DIR: path.join(temp, role + index, 'dossiers'), UPLOADS_DIR: path.join(temp, role + index, 'uploads'),
    MODELS_DIR: path.join(temp, role + index, 'models'),
    KP_CHUNK_STREAM: '0', KP_WIRE_SAMPLING: '0',
    KP_METRICS_TOKEN: metricsToken, KP_METRICS_PORT: role === 'worker' ? String(p) : undefined,
  })
  const child = spawn(process.execPath, ['--import', tsxLoader, '--import', keeperFixture, entry], {
    cwd: processDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const processRecord = { role, index, p, child, base: 'http://127.0.0.1:' + p, active: true, fault: new Map(), disarmed: new Set() }
  children.add(processRecord)
  let diagnostic = ''
  child.on('error', (error) => { processRecord.startError = errorTag(error) })
  child.on('exit', () => { processRecord.active = false })
  child.stdout.on('data', (chunk) => {
    if (role === 'worker' && String(chunk).includes('Room worker ready')) processRecord.ready = true
  })
  child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + String(chunk)).slice(-6000) })
  child.on('message', (message) => {
    if (role === 'prep' && message.type === 'preparation-ready') processRecord.ready = true
    if (message.type === 'sample') {
      const { type, ...measurements } = message
      samples.push({ t: performance.now(), phase: trafficStarted ? 'mixed' : 'setup', role, index, ...measurements })
    }
    if (message.type === 'disarmed') processRecord.disarmed.add(message.id)
    if (message.type === 'fault') processRecord.fault.set(message.id, message.stage)
    if (message.type === 'provider') provider.push({ ...message, worker: index })
  })
  try {
    await until(async () => {
      if (!processRecord.active || processRecord.startError) return false
      if (role !== 'gateway') return processRecord.ready
      const ready = await fetch(processRecord.base + '/health/ready', { signal: AbortSignal.timeout(1000) }).catch(() => null)
      return ready?.ok
    }, 30000, role + '_startup')
    processRecord.ready = true
    return processRecord
  } catch (error) {
    // Report only recognized error classes, never raw driver errors or credentials.
    const recognized = diagnostic.match(/\b(?:ERR_[A-Z0-9_]+|[A-Za-z]+Error)\b|PostgreSQL operation failed \([A-Z0-9]{5}\)/g)
    setup.push({ role, index, failure: errorTag(error), diagnostics: [...new Set(recognized)] })
    throw error
  }
}

async function stop(processRecord, signal = 'SIGTERM') {
  if (!processRecord.active) return
  const exited = once(processRecord.child, 'exit')
  processRecord.child.kill(signal)
  const limit = delay(5000, null, { ref: false })
  if (await Promise.race([exited, limit]) === null && processRecord.active) {
    processRecord.child.kill('SIGKILL')
    await exited
  }
}

function request(gateway, route, id, options = {}) {
  return fetch(gateway.base + route, {
    ...options, headers: { Authorization: 'Bearer ' + token(id), ...options.headers },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  })
}

async function importStory(serial, phase) {
  const format = formats[(serial - 1) % formats.length]
  const id = 2 + (serial % Math.max(1, report.users - 1))
  const file = 'synthetic-' + serial + '.' + format
  const result = { serial, id, file, format, phase, startedAt: Date.now(), offeredAt: performance.now() }
  const gateway = () => {
    const available = activeGateways()
    return available[serial % available.length]
  }
  imports.push(result)
  try {
    const bytes = await source(format, serial + config.seed)
    result.sourceBytes = bytes.length
    const form = new FormData()
    form.append('file', new Blob([bytes]), file)
    const uploadGateway = gateway()
    const dispatchAt = performance.now()
    const uploadRequest = request(uploadGateway, '/api/stories/upload', id, { body: form, method: 'POST' })
    result.firstDispatchAt = dispatchAt
    const upload = await uploadRequest
    result.uploadStatus = upload.status
    const uploaded = await upload.json()
    if (!upload.ok || !uploaded.id) return result
    const preparation = '/api/stories/' + encodeURIComponent(uploaded.id) + '/preparation'
    const admission = await request(gateway(), preparation, id, {
      method: 'POST', body: JSON.stringify({ operationId: 'stage126-' + serial }),
      headers: { 'Content-Type': 'application/json' },
    })
    result.admissionStatus = admission.status
    const body = await admission.json()
    result.jobId = body.job?.id
    result.file = uploaded.id
    result.admittedMs = Date.now() - result.startedAt
  } catch (error) {
    result.error = errorTag(error)
  }
  return result
}

async function checkImports(rows, timeoutMs) {
  const ids = new Map(rows.filter((row) => row.jobId).map((row) => [row.jobId, row]))
  if (!ids.size) return
  await until(async () => {
    const response = await pool.query(
      'SELECT job_id, state, stage FROM story_preparation_jobs WHERE job_id = ANY($1::uuid[])',
      [[...ids.keys()]],
    )
    for (const row of response.rows) {
      const item = ids.get(row.job_id)
      item.state = row.state
      item.stage = row.stage
      if (['complete', 'failed', 'cancelled'].includes(row.state)) item.terminalMs ??= Date.now() - item.startedAt
    }
    return response.rows.length === ids.size && response.rows.every((row) => ['complete', 'failed', 'cancelled'].includes(row.state))
  }, timeoutMs, 'import_terminal_timeout').catch((error) => failures.push({ phase: 'import', code: errorTag(error) }))
}

function client(id, room, gateway) {
  return {
    id, room, gateway, seq: 0, events: new Map(), status: new Map(), regressions: 0,
    inconsistentReplayFrames: 0, transportDrops: 0,
  }
}

function applyFrame(person, frame, gateway) {
  if (frame.type === 'room:state' || frame.type === 'room:sync:done') {
    if (frame.seq < person.seq) person.regressions++
    person.seq = Math.max(person.seq, frame.seq)
  }
  if (frame.type === 'room:action:result') {
    const arrivedAt = performance.now()
    person.status.set(frame.actionId, { ...frame, arrivedAt, gateway })
    const action = actions.get(frame.actionId)
    if (action?.userId === person.id && ['pending', 'completed', 'cancelled'].includes(frame.status)) {
      action.ack ??= arrivedAt - action.started
      action.wireReceipts.push({ roomId: frame.roomId, status: frame.status, messageId: frame.messageId })
    }
    return
  }
  if (frame.type !== 'room:event') return
  const previousSeq = person.replaying ? person.replaySeq : person.seq
  if (frame.seq < previousSeq) person.regressions++
  if (person.replaying) person.replaySeq = Math.max(person.replaySeq, frame.seq)
  person.seq = Math.max(person.seq, frame.seq)
  const previous = person.events.get(frame.seq)
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(frame)) person.inconsistentReplayFrames++
  } else {
    person.events.set(frame.seq, frame)
  }
  const message = frame.payload?.message
  if (frame.eventType === 'message_appended' && typeof message?.content === 'string') {
    for (const [, id] of message.content.matchAll(/\b(load-[\w-]+)\b/g)) {
      const action = actions.get(id)
      if (!action || action.room !== person.room) continue
      if (message.role === 'player' && person.id === action.userId) action.echo ??= performance.now() - action.started
      if (message.role === 'kp' && person.id === action.userId) action.turn ??= performance.now() - action.started
    }
  }
  if (frame.eventType === 'state_patch' && frame.payload?.path === 'kpPauseReason') {
    const code = frame.payload?.value
    if (code) failures.push({ phase: 'pause', code })
  }
}

async function connect(person, destination = person.gateway, cursor) {
  const socket = new WebSocket(gates[destination].base.replace(/^http:/, 'ws:') + '/ws?token=' + token(person.id), {
    handshakeTimeout: 10000,
  })
  person.socket = socket
  person.gateway = destination
  person.replaying = cursor !== undefined
  person.replaySeq = cursor
  let response
  let opened = false
  socket.once('open', () => {
    opened = true
    if (duringPacedTraffic()) pacedTransports.established++
  })
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    applyFrame(person, frame, destination)
    if (frame.roomId !== person.room) return
    if (frame.type === 'room:event' && frame.eventType === 'room_meta') socket.roomPhase = frame.payload?.phase
    if (frame.type === 'room:state') socket.roomPhase = frame.snapshot?.phase
    if (['room:state', 'room:sync:done', 'room:error'].includes(frame.type)) {
      response ??= { type: frame.type, bytes: raw.length, roomPhase: socket.roomPhase, seq: frame.seq, arrivedAt: performance.now() }
      person.replaying = false
    }
  })
  socket.once('unexpected-response', (_request, response) => {
    const status = response.statusCode
    response.resume()
    socket.handshakeFailure = 'http_' + status
    socket.terminate()
  })
  socket.on('error', () => socket.terminate())
  socket.on('close', () => {
    if (socket.intentional || socket.gatewayFailure) return
    person.transportDrops++
    if (opened && duringPacedTraffic()) pacedTransports.unexpectedDrops++
  })
  try {
    await once(socket, 'open')
    if (!person.room) return { type: 'idle' }
    socket.send(JSON.stringify(cursor === undefined
      ? { type: 'room:join', roomId: person.room }
      : { type: 'room:sync', roomId: person.room, lastSeq: cursor }))
    const result = await until(() => response || (socket.readyState === WebSocket.CLOSED && { type: 'closed' }), 15000, 'join_timeout')
    const replayed = cursor !== undefined && result.type === 'room:sync:done'
    if (!replayed && !(result.type === 'room:state' && result.roomPhase === 'playing')) {
      throw Object.assign(new Error('Room subscription failed'), { code: result.type })
    }
    if (replayed) socket.roomPhase ??= person.lastKnownRoomPhase
    socket.roomVerified = true
    return result
  } catch (error) {
    socket.terminate()
    if (socket.handshakeFailure) throw Object.assign(error, { code: socket.handshakeFailure })
    throw error
  }
}

function duringPacedTraffic() {
  return trafficStarted !== undefined && performance.now() - trafficStarted < config.pacedSec * 1000
}

async function reconnect(person, gateway, phase, started, cursor) {
  const previous = person.reconnectQueue
  const attempt = (async () => {
    await previous
    await performReconnect(person, gateway, phase, started, cursor ?? person.seq)
  })()
  person.reconnectQueue = attempt
  try {
    await attempt
  } finally {
    if (person.reconnectQueue === attempt) person.reconnectQueue = undefined
  }
}

async function performReconnect(person, gateway, phase, started, cursor) {
  person.rejoined = true
  const record = { phase, clientId: person.id, gateway, requestedCursor: cursor, active: !!person.room }
  const attemptStarted = performance.now()
  reconnects.push(record)
  try {
    if (person.socket) {
      person.lastKnownRoomPhase = person.socket.roomPhase ?? person.lastKnownRoomPhase
      person.socket.intentional = true
      person.socket.terminate()
    }
    Object.assign(record, await connect(person, gateway, cursor))
    const arrived = record.arrivedAt ?? performance.now()
    record.ms = arrived - started
    record.attemptMs = arrived - attemptStarted
  } catch (error) {
    record.failure = errorTag(error)
  }
}

function send(person, action) {
  if (person.socket?.readyState !== WebSocket.OPEN) return false
  person.status.delete(action.id)
  const frame = JSON.stringify({
    type: 'room:action', roomId: action.room, actionId: action.id,
    action: { type: 'chat', payload: { content: 'I examine the archive ' + action.id } },
  })
  const dispatchAt = performance.now()
  person.socket.send(frame)
  action.firstDispatchAt ??= dispatchAt
  if (action.phase === 'paced') {
    action.sentSinceMixedMs = performance.now() - trafficStarted
    action.sentGateway = person.gateway
  }
  return true
}

function offer(person, phase, suffix, scheduledAt = performance.now()) {
  const id = 'load-' + suffix
  const action = {
    id, userId: person.id, phase, room: person.room, scheduledAt,
    started: performance.now(), sent: false, attempts: 0, replies: [], wireReceipts: [],
  }
  actions.set(id, action)
  return action
}

async function admit(person, action, budgetMs, retry = true) {
  const deadline = performance.now() + budgetMs
  while (performance.now() < deadline) {
    if (send(person, action)) {
      action.attempts++
      action.sent = true
      const result = await until(() => person.status.get(action.id), Math.min(2400, deadline - performance.now()), 'receipt_timeout').catch(() => null)
      if (result) {
        const ms = result.arrivedAt - action.started
        action.replies.push({ status: result.status, code: result.code, ms })
        if (['pending', 'completed', 'cancelled'].includes(result.status)) return result
        if (result.status === 'rejected') return result
      }
    }
    if (!retry) return
    await delay(150 + person.id % 113)
  }
}

function schedule(count, durationMs, run, first = performance.now()) {
  return Promise.all(Array.from({ length: count }, (_, index) => {
    const at = first + Math.floor(index * durationMs / count)
    return delay(Math.max(0, at - performance.now())).then(() => run(index, at))
  }))
}

async function browse(index, phase) {
  const owner = index % 3 === 0 ? 1 : 2 + Math.floor(index / 3) % (report.users - 1)
  const key = phase + ':' + owner
  const cursor = catalogCursors.get(key)
  const available = activeGateways()
  const gate = available[index % available.length]
  const record = { phase, owner: owner === 1 ? 'large' : 'small', page: cursor ? 'later' : 'first', warm: catalogCursors.has(key) }
  catalog.push(record)
  const begun = performance.now()
  try {
    const response = await request(gate, '/api/stories?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), owner)
    record.status = response.status
    const page = await response.json()
    if (!response.ok || !Array.isArray(page.stories) || page.stories.length > 25) throw new Error('Invalid metadata page')
    catalogCursors.set(key, page.nextCursor ?? null)
    record.ms = performance.now() - begun
  } catch (error) {
    record.failure = errorTag(error)
  }
}

const catalogCursors = new Map()
const activeGateways = () => gates.filter((gate) => gate?.active && !gate.draining)
const owners = () => clients.slice(0, config.rooms)
const pendingTimers = new Set()
function track(promise) {
  pendingTimers.add(promise)
  void promise.finally(() => pendingTimers.delete(promise)).catch(() => {})
  return promise
}

async function sampleDatabase() {
  const t = performance.now()
  try {
    const { rows: [database] } = await pool.query(`
      SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS server_connections,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS lock_waits,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'IO') AS io_waits,
        (SELECT count(*) FROM room_commands WHERE result IS NULL) AS pending_commands,
        (SELECT count(*) FROM rooms WHERE turn_pending) AS pending_rooms,
        (SELECT extract(epoch FROM clock_timestamp() - min(expires_at) + interval '2500 milliseconds') * 1000
          FROM room_commands WHERE result IS NULL AND NOT presence_loss) AS oldest_regular_command_ms,
        (SELECT count(*) FROM story_preparation_jobs WHERE state IN ('queued', 'running')) AS pending_imports,
        (SELECT extract(epoch FROM clock_timestamp() - min(deadline_at) + interval '30 minutes') * 1000
          FROM story_preparation_jobs WHERE state IN ('queued', 'running')) AS oldest_import_ms,
        (SELECT blks_read FROM pg_stat_database WHERE datname = current_database()) AS blocks_read,
        (SELECT blks_hit FROM pg_stat_database WHERE datname = current_database()) AS blocks_hit,
        (SELECT COALESCE(jsonb_agg(to_jsonb(waits)), '[]'::jsonb) FROM (
          SELECT application_name AS application, wait_event_type AS kind, wait_event AS event, count(*)::int
          FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type IN ('Lock', 'IO', 'LWLock')
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
        ) waits) AS wait_breakdown
    `)
    const active = [...actions.values()].filter((a) => a.ack !== undefined && a.turn === undefined && a.terminal === undefined)
    const oldestUnfinishedEchoMs = active.length ? t - active[0].started : null
    const socketCounts = gates.map((g, gateway) => {
      const connected = clients.filter((c) => c.gateway === gateway && c.socket?.readyState === WebSocket.OPEN)
      return { gateway, sockets: connected.length, rooms: new Set(connected.flatMap((c) => c.room ? [c.room] : [])).size }
    })
    const { wait_breakdown: waitBreakdown, ...counters } = database
    samples.push({
      t, role: 'database', probeMs: performance.now() - t, oldestUnfinishedEchoMs, waitBreakdown,
      ...Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value === null ? null : Number(value)])),
      socketCounts, loadRss: process.memoryUsage.rss(), generatorLoopP99Ms: loop.percentile(99) / 1e6,
    })
  } catch (error) {
    failures.push({ phase: 'sampling', code: errorTag(error) })
  }
}

async function recordDurable(records) {
  if (!records.length) return
  const { rows } = await pool.query('SELECT room_id, user_id, action_id, status, message_id FROM room_actions WHERE action_id = ANY($1::text[])', [
    records.map((action) => action.id),
  ])
  for (const row of rows) {
    const action = actions.get(row.action_id)
    if (action.room !== row.room_id || action.userId !== Number(row.user_id)) throw new Error('Receipt identity mismatch')
    action.durableStatus = row.status
    action.durableMessageId = row.message_id
    if (row.status !== 'pending') action.terminal ??= performance.now() - action.started
  }
}

async function waitForDurable(records, timeoutMs, condition) {
  await until(async () => {
    await recordDurable(records.filter((action) => action.terminal === undefined))
    return records.every((action) => action.terminal !== undefined)
  }, timeoutMs, condition).catch((error) => failures.push({ phase: condition, code: errorTag(error) }))
}

async function membershipRoster() {
  const { rows } = await pool.query('SELECT room_id, user_id, role FROM room_members ORDER BY room_id, user_id')
  return rows
}

async function restartGateway() {
  const dead = gates[0]
  const membersBefore = await membershipRoster()
  const affected = clients.filter((person) => person.gateway === dead.index && person.socket?.readyState === WebSocket.OPEN)
  const started = performance.now()
  dead.draining = true
  const recovery = report.gatewayFailure = {
    gateway: dead.index, affected: affected.length, membersBefore: membersBefore.length, startedSinceMixedMs: started - trafficStarted,
  }
  for (const person of affected) person.socket.gatewayFailure = true
  // Signal handlers can be exercised without Windows' forced signal emulation.
  dead.child.send('drain')
  await until(() => !dead.active, 8000, 'gateway_drain_timeout')
  const survivors = activeGateways().map((gate) => gate.index)
  await batches(affected, config.joinConcurrency, (person) =>
    reconnect(person, survivors[(person.id - 1) % survivors.length], 'gateway_restart', started))
  gates[0] = await start('gateway', dead.index, dead.p)
  const ready = performance.now()
  recovery.replacementReadyMs = ready - started
  recovery.replacementReadySinceMixedMs = ready - trafficStarted
  const membersAfter = await membershipRoster()
  Object.assign(recovery, {
    membersAfter: membersAfter.length,
    membershipPreserved: JSON.stringify(membersBefore) === JSON.stringify(membersAfter),
    restartAfterRejoin: true, exitCode: dead.child.exitCode,
  })
}

async function restartRoomWorkers() {
  const results = []
  const targetedRooms = new Set()
  report.workerFailures = results
  for (const [slot, dead] of workers.entries()) {
    const stage = slot % 2 === 0 ? 'ack' : 'effect'
    const result = { stage, workerSlot: slot }
    results.push(result)
    let action
    try {
      const eligible = owners().filter((person) => person.socket?.readyState === WebSocket.OPEN &&
        !person.reconnectQueue && !targetedRooms.has(person.room))
      const victim = eligible.find((person) => person.gateway !== 0) ?? eligible[0]
      if (!victim) throw Object.assign(new Error('No connected fault target'), { code: 'no_connected_fault_target' })
      targetedRooms.add(victim.room)
      action = offer(victim, 'recovery', stage + '-' + slot)
      Object.assign(result, { id: action.id, targetRoom: victim.room })
      // Arm every worker and kill whichever owns the target room. A rolling
      // restart of the other slots still runs even if a particular fault misses.
      for (const worker of workers) worker.child.send({ type: 'arm', id: action.id })
      await delay(100)
      const acknowledged = await admit(victim, action, 5000)
      const actual = await until(() => workers.find((entry) => entry.fault.get(action.id) === stage), 7000, 'fault_barrier_timeout')
      await recordDurable([action])
      result.originalGateway = acknowledged?.gateway
      result.acknowledgedBeforeKill = acknowledged?.status === 'pending' && action.durableStatus === 'pending'
      assert(result.acknowledgedBeforeKill, 'Fault victim lacks a pending durable acknowledgement')
      const before = await pool.query('SELECT worker_epoch, worker_id FROM rooms WHERE room_id = $1', [action.room])
      result.previousEpoch = Number(before.rows[0].worker_epoch)
      const survivors = workers.filter((worker) => worker !== actual && worker.active)
      for (const worker of survivors) worker.child.send({ type: 'disarm', id: action.id })
      await until(() => survivors.every((worker) => worker.disarmed.has(action.id)), 3000, 'barrier_disarm_timeout')
      const kill = performance.now()
      result.killedSinceMixedMs = kill - trafficStarted
      await stop(actual, 'SIGKILL')
      const other = activeGateways().find((gate) => gate.index !== result.originalGateway)
      if (other) await reconnect(victim, other.index, 'worker_failover', kill)
      else await reconnect(victim, victim.gateway, 'worker_failover', kill)
      await waitForDurable([action], 60000, 'worker_recovery_timeout')
      const replacement = await pool.query('SELECT worker_epoch FROM rooms WHERE room_id = $1', [action.room])
      result.recoveredEpoch = Number(replacement.rows[0].worker_epoch)
      if (action.terminal !== undefined) {
        const recovered = action.terminal + action.started
        result.recoveredMs = recovered - kill
        result.recoveredSinceMixedMs = recovered - trafficStarted
      }
      const replay = await admit(victim, action, 5000)
      result.replayedReceipt = replay?.status
      result.replayGateway = replay?.gateway
      result.resentElsewhere = replay !== undefined && replay.gateway !== result.originalGateway
      const index = workers.indexOf(actual)
      workers[index] = await start('worker', actual.index, actual.p)
      if (actual !== dead && dead.active) {
        await stop(dead, 'SIGKILL')
        workers[slot] = await start('worker', dead.index, dead.p)
        result.additionalRolledWorker = dead.index
      }
      result.replacementReadySinceMixedMs = performance.now() - trafficStarted
    } catch (error) {
      result.failure = errorTag(error)
      if (action) {
        for (const worker of workers.filter((entry) => entry.active && entry.child.connected)) {
          worker.child.send({ type: 'disarm', id: action.id }, () => {})
        }
      }
      if (dead.active) {
        await stop(dead, 'SIGKILL')
        workers[slot] = await start('worker', dead.index, dead.p)
      }
      for (const entry of workers.filter((worker) => !worker.active)) {
        workers[entry.index] = await start('worker', entry.index, entry.p)
      }
    }
  }
}

async function reconcile() {
  const all = [...actions.values()]
  await batches(all.filter((action, index) => index % 1000 === 0), 1, (marker) => {
    const index = all.indexOf(marker)
    return recordDurable(all.slice(index, index + 1000))
  })
  const duplicate = await pool.query(`
    SELECT count(*)::int AS count FROM (
      SELECT room_id, key->>'userId', key->>'actionId'
      FROM room_turns CROSS JOIN LATERAL jsonb_array_elements(action_keys) AS key
      GROUP BY 1, 2, 3 HAVING count(*) > 1
    ) repeated
  `)
  const outcome = await pool.query('SELECT outcome, count(*)::int AS count FROM room_turns GROUP BY outcome')
  const effects = await pool.query(`
    SELECT a.action_id, r.state::jsonb->'characters'->c.id->'derived'->>'hp' AS hp,
      (SELECT count(*)::int FROM room_events e WHERE e.room_id = a.room_id
        AND e.event_type = 'state_patch' AND e.payload->>'path' = 'characters.' || c.id) AS patches
    FROM room_actions a JOIN characters c ON c.user_id = a.user_id JOIN rooms r ON r.room_id = a.room_id
    WHERE a.action_id LIKE 'load-effect-%'
  `)
  let compared = 0
  let mismatches = 0
  let unpairedDuringContinuousConnection = 0
  for (let i = 0; i < config.multiRooms; i++) {
    const left = clients[i]
    const right = clients[i + config.rooms]
    for (const [seq, first] of left.events) {
      const second = right.events.get(seq)
      if (!second) continue
      compared++
      if (JSON.stringify(first) !== JSON.stringify(second)) mismatches++
    }
    if (!left.transportDrops && !right.transportDrops && !left.rejoined && !right.rejoined) {
      for (const seq of new Set([...left.events.keys(), ...right.events.keys()])) {
        if (!left.events.has(seq) || !right.events.has(seq)) unpairedDuringContinuousConnection++
      }
    }
  }
  return {
    acknowledged: all.filter((a) => a.ack !== undefined).length,
    missingAcknowledged: all.filter((a) => a.ack !== undefined && !a.durableStatus).map((a) => a.id),
    mismatchedReceipts: all.filter((action) => action.wireReceipts.some((receipt) =>
      receipt.roomId !== action.room || (receipt.messageId !== undefined && receipt.messageId !== action.durableMessageId) ||
      (receipt.status !== 'pending' && receipt.status !== action.durableStatus))).map((action) => action.id),
    pendingAcknowledged: all.filter((a) => a.ack !== undefined && a.durableStatus === 'pending').map((a) => a.id),
    duplicateCommittedActionKeys: duplicate.rows[0].count, compared, mismatches, unpairedDuringContinuousConnection,
    sequenceRegressions: clients.reduce((sum, client) => sum + client.regressions, 0),
    inconsistentReplayFrames: clients.reduce((sum, client) => sum + client.inconsistentReplayFrames, 0),
    unexpectedTransportDrops: clients.reduce((sum, client) => sum + client.transportDrops, 0),
    turnOutcomes: outcome.rows, effects: effects.rows,
  }
}

function summarizeActions() {
  return Object.fromEntries(['warmup', 'paced', 'burst', 'recovery'].map((phase) => {
    const rows = [...actions.values()].filter((action) => action.phase === phase)
    const duration = phase === 'burst' ? 1 : phase === 'paced' ? config.pacedSec : phase === 'warmup' ? config.warmupSec : null
    const accepted = rows.filter((row) => row.ack !== undefined).length
    const liveCompleted = rows.filter((row) => row.turn !== undefined).length
    const firstResponseCodes = {}
    const allResponseCodes = {}
    for (const row of rows) {
      const key = (reply) => reply ? (reply.code ?? reply.status) : 'no_response'
      const initial = key(row.replies[0])
      firstResponseCodes[initial] = (firstResponseCodes[initial] ?? 0) + 1
      for (const reply of row.replies) {
        const code = key(reply)
        allResponseCodes[code] = (allResponseCodes[code] ?? 0) + 1
      }
    }
    return [phase, {
      offered: rows.length, sent: rows.filter((row) => row.sent).length, accepted, liveCompleted,
      durableTerminal: rows.filter((row) => row.terminal !== undefined).length,
      finalizedWithin30s: rows.filter((row) => row.terminal <= 30000).length,
      offeredPerSec: duration ? rows.length / duration : null, acceptedPerOfferSecond: duration ? accepted / duration : null,
      completedPerOfferSecond: duration ? liveCompleted / duration : null,
      firstResponseCodes, allResponseCodes, admission: percentile(rows.map((r) => r.ack)),
      echo: percentile(rows.map((r) => r.echo)), keeper: percentile(rows.map((r) => r.turn)),
      terminalObservation: percentile(rows.map((r) => r.terminal)),
      dispatchLag: percentile(rows.map((r) => r.started - r.scheduledAt)),
    }]
  }))
}

function capacities() {
  const databaseSamples = samples.filter((sample) => sample.role === 'database')
  const peakWaits = new Map()
  for (const sample of databaseSamples) {
    for (const wait of sample.waitBreakdown) {
      const key = [wait.application, wait.kind, wait.event].join(':')
      if (wait.count > (peakWaits.get(key)?.count ?? 0)) peakWaits.set(key, wait)
    }
  }
  return {
    maximumSamplesByReplica: gates.map((gate, index) => ({
      gateway: index,
      sockets: Math.max(0, ...databaseSamples.map((s) => s.socketCounts[index]?.sockets ?? 0)),
      rooms: Math.max(0, ...databaseSamples.map((s) => s.socketCounts[index]?.rooms ?? 0)),
    })),
    processes: [...new Set(samples.filter((s) => s.rss).map((s) => s.role + '-' + s.index))].map((label) => ({
      label, maximumRss: Math.max(...samples.filter((s) => s.role + '-' + s.index === label).map((s) => s.rss)),
    })),
    queryRoundTrip: percentile(databaseSamples.map((s) => s.probeMs)),
    maxConnections: Math.max(0, ...databaseSamples.map((s) => s.connections)),
    maxServerConnections: Math.max(0, ...databaseSamples.map((s) => s.server_connections)),
    maxLockWaits: Math.max(0, ...databaseSamples.map((s) => s.lock_waits)),
    maxIoWaits: Math.max(0, ...databaseSamples.map((s) => s.io_waits)),
    maxPendingCommands: Math.max(0, ...databaseSamples.map((s) => s.pending_commands)),
    maxPendingRooms: Math.max(0, ...databaseSamples.map((s) => s.pending_rooms)),
    maxPendingImports: Math.max(0, ...databaseSamples.map((s) => s.pending_imports)),
    oldestImportMs: percentile(databaseSamples.map((s) => s.oldest_import_ms)),
    oldestRegularCommandMs: percentile(databaseSamples.map((s) => s.oldest_regular_command_ms)),
    oldestClientObservedUnfinishedMs: percentile(databaseSamples.map((s) => s.oldestUnfinishedEchoMs)),
    generatorRss: Math.max(process.memoryUsage.rss(), ...databaseSamples.map((sample) => sample.loadRss)),
    peakWaits: [...peakWaits.values()].sort((left, right) => right.count - left.count),
    generatorEventLoopP99Ms: loop.percentile(99) / 1e6,
  }
}

function sampleOccupancy(phase, t = performance.now()) {
  const sample = { t, phase, ...occupancy(clients, config.gateways, WebSocket.OPEN) }
  occupancySamples.push(sample)
  return sample
}

async function waitForWindowEnd(deadline) {
  while (performance.now() < deadline) {
    await delay(Math.max(1, Math.ceil(deadline - performance.now())), undefined, { ref: false })
  }
}

function summarizeOccupancy() {
  return Object.fromEntries(['warmup', 'paced'].map((phase) => {
    const observed = occupancySamples.filter((sample) => sample.phase === phase)
    const range = (key) => observed.length
      ? { min: Math.min(...observed.map((sample) => sample[key])), max: Math.max(...observed.map((sample) => sample[key])) }
      : null
    return [phase, {
      samples: observed.length,
      maxSampleGapMs: observed.length > 1 ? Math.max(...observed.slice(1).map((sample, index) => sample.t - observed[index].t)) : null,
      openSockets: range('openSockets'),
      playingRooms: range('playingRooms'),
      crossGatewayMultiplayerRooms: range('crossGatewayMultiplayerRooms'),
      samplesWithReferenceSocketAndRoomCounts: observed.filter((sample) =>
        sample.openSockets === 5000 && sample.playingRooms === 2500).length,
    }]
  }))
}


function budgets() {
  const { summary, catalog: catalogSummary, reconnect, integrity } = report
  const result = (measured, passed) => measured ? (passed ? 'passed' : 'missed') : 'unmeasured'
  const latency = (value, p95, p99) => result(value.count, value.p95 <= p95 && value.p99 <= p99)
  const pace = summary.paced
  const burst = summary.burst
  const rolling = reconnect.gateway_restart
  const wave = reconnect.client_wave
  const workerClients = reconnect.worker_failover
  const recoveries = report.workerFailures ?? []
  const gateway = report.gatewayFailure
  const effectRecoveries = recoveries.filter((row) => row.stage === 'effect')
  const mixedCatalog = catalog.filter((row) => row.phase === 'mixed')
  const pacedImports = imports.filter((row) => row.phase === 'paced')
  const failureRate = (offered, failed) => ({ offered, failed, budget: result(offered, failed / offered <= .005) })
  report.pacedFailures = {
    actions: failureRate(pace.offered, pace.offered - pace.liveCompleted),
    catalog: failureRate(mixedCatalog.length, mixedCatalog.filter((row) => row.failure).length),
    imports: failureRate(pacedImports.length, pacedImports.filter((row) => row.state !== 'complete').length),
    socketDrops: failureRate(pacedTransports.established, pacedTransports.unexpectedDrops),
  }
  const failureBudgets = Object.values(report.pacedFailures).map((row) => row.budget)
  const pacedActions = [...actions.values()].filter((action) => action.phase === 'paced' && action.sent)
  const overlap = (start, end, unrelated) => {
    const dispatches = pacedActions.filter((action) =>
      action.sentSinceMixedMs >= start && action.sentSinceMixedMs < end && unrelated(action)).length
    return { unrelatedDispatches: dispatches, fullyWithinPaced: start >= 0 && end <= config.pacedSec * 1000 }
  }
  if (gateway) gateway.pacedOverlap = overlap(gateway.startedSinceMixedMs, gateway.replacementReadySinceMixedMs,
    (action) => action.sentGateway !== gateway.gateway)
  for (const worker of recoveries) {
    worker.pacedOverlap = overlap(worker.killedSinceMixedMs,
      Math.max(worker.recoveredSinceMixedMs, worker.replacementReadySinceMixedMs),
      (action) => action.room !== worker.targetRoom)
  }
  const overlapsPaced = (fault) => fault?.pacedOverlap?.fullyWithinPaced && fault.pacedOverlap.unrelatedDispatches > 0
  return {
    scope: 'Diagnostic budgets for the observed run. See workload.referenceWorkload and workload.referenceAcceptance.',
    pacedEcho: latency(pace.echo, 500, 1500),
    pacedKeeper: latency(pace.keeper, 2000, 5000),
    catalogWarm: latency(catalogSummary.reusedOwner, 200, 750),
    pacedFailures: failureBudgets.includes('missed') ? 'missed'
      : failureBudgets.every((budget) => budget === 'passed') ? 'passed' : 'unmeasured',
    burstTerminal: result(burst.offered, burst.finalizedWithin30s / burst.offered >= .999),
    durableAcknowledgements: result(integrity?.acknowledged,
      !integrity?.missingAcknowledged.length && !integrity?.pendingAcknowledged.length && !integrity?.mismatchedReceipts.length),
    sequenceIntegrity: result(integrity?.compared,
      !integrity?.mismatches && !integrity?.sequenceRegressions && !integrity?.unpairedDuringContinuousConnection &&
      !integrity?.inconsistentReplayFrames),
    duplicateRuleEffects: result(integrity, integrity?.duplicateCommittedActionKeys === 0 &&
      effectRecoveries.length === Math.floor(config.roomWorkers / 2) &&
      integrity?.effects.length === effectRecoveries.length && effectRecoveries.every((row) =>
        row.acknowledgedBeforeKill && row.replayedReceipt === 'completed' && integrity.effects.some((effect) =>
          effect.action_id === row.id && effect.hp === '8' && effect.patches === 1))),
    clientWaveRecovery: result(config.reconnect && wave.offered, wave.within30s / config.reconnect >= .99),
    gatewayRecovery: result(gateway, gateway?.affected > 0 && rolling.within30s / gateway.affected >= .99 &&
      gateway.replacementReadyMs <= 30000 && gateway.membershipPreserved),
    workerRecovery: result(recoveries.length, recoveries.length === config.roomWorkers &&
      workerClients.within30s / recoveries.length >= .99 && recoveries.every((row) =>
        !row.failure && Number.isFinite(row.replacementReadySinceMixedMs) &&
        row.acknowledgedBeforeKill && row.recoveredMs >= 0 && row.recoveredMs <= 60000 &&
        row.recoveredEpoch > row.previousEpoch && row.replayedReceipt === 'completed' && row.resentElsewhere)),
    pacedFaultOverlap: result(recoveries.length || gateway,
      recoveries.length === config.roomWorkers && overlapsPaced(gateway) && recoveries.every(overlapsPaced)),
    saturation: 'unmeasured',
    liveByok: 'unmeasured',
  }
}

let stage = 'preflight'
try {
  const identity = await pool.query(`
    SELECT current_database() AS db, current_user AS role, version() AS version,
      current_setting('max_connections')::int AS max_connections,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS tables
  `)
  const [database] = identity.rows
  assert.equal(database.db, postgres.pathname.slice(1))
  assert.equal(database.role, postgres.username)
  assert.equal(database.tables, 0, 'Use a newly provisioned empty scratch database for each run')
  report.postgres = { version: database.version, maxConnections: database.max_connections, serverPoolDefaultMax: 10 }
  const objectStarted = performance.now()
  const head = await s3.send(new HeadBucketCommand({ Bucket: objectStore.bucket }), { abortSignal: AbortSignal.timeout(5000) })
  report.objectStorage = { headMs: performance.now() - objectStarted, status: head.$metadata.httpStatusCode }
  stage = 'startup'
  console.log('Starting synthetic gateways and workers')
  gates.push(await start('gateway', 0))
  await Promise.all([
    ...Array.from({ length: config.gateways - 1 }, (_, index) => start('gateway', index + 1).then((gate) => { gates[index + 1] = gate })),
    ...Array.from({ length: config.roomWorkers }, (_, index) => start('worker', index).then((worker) => { workers[index] = worker })),
    ...Array.from({ length: config.prepWorkers }, (_, index) => start('prep', index)),
  ])
  loop.enable()
  sampling = setInterval(() => {
    for (const entry of children) if (entry.active && entry.child.connected) entry.child.send('sample', () => {})
    if (occupancyPhase) sampleOccupancy(occupancyPhase)
    track(sampleDatabase())
  }, 1000)
  stage = 'fixture_data'
  report.users = Math.max(config.owners, totalSockets)
  await seedAccounts(pool, report.users, config)
  const { rows: [seeded] } = await pool.query(`
    SELECT COALESCE(sum(stories), 0) AS "metadataRows", count(*) AS "catalogOwners",
      COALESCE(max(stories), 0) AS "largestLibrary"
    FROM (SELECT count(*) AS stories FROM story_catalog WHERE deleted_at IS NULL GROUP BY owner_id) libraries
  `)
  Object.assign(workload.actual, Object.fromEntries(Object.entries(seeded).map(([key, count]) => [key, Number(count)])))
  const sourceCount = config.artifactsPerFormat * formats.length
  const prepared = []
  await batches(Array.from({ length: sourceCount }, (_, i) => i + 1), Math.min(24, report.users - 1), async (serial) => {
    prepared.push(await importStory(serial, 'fixture'))
  })
  await checkImports(prepared, Math.max(60000, sourceCount * 8000))
  const { rows: pins } = await pool.query(`
    SELECT c.story_id, c.owner_id AS story_owner_id, r.revision, r.source_revision, r.objects, r.job_id
    FROM story_catalog c JOIN story_preparation_revisions r ON r.revision = c.active_preparation_revision
    JOIN story_preparation_jobs j ON j.job_id = r.job_id
    WHERE c.deleted_at IS NULL AND c.source_size > 0 AND c.source_revision = r.source_revision
      AND c.owner_id = r.owner_id AND c.story_id = r.story_id AND j.state = 'complete'
    ORDER BY c.owner_id, c.story_id
  `)
  const fixtureFormats = new Map(prepared.map((row) => [row.jobId, row.format]))
  workload.preparedByFormat = Object.fromEntries(formats.map((format) =>
    [format, pins.filter((pin) => fixtureFormats.get(pin.job_id) === format).length]))
  assets.push(...pins.map((pin) => ({
    format: pin.story_id.split('.').at(-1),
    artifactSizes: Object.fromEntries(Object.entries(pin.objects).map(([name, detail]) => [name, detail.size])),
  })))
  assert(pins.length > 0, 'At least one coherent playable fixture is required')
  await seedRooms(pool, config.rooms, config.multiRooms, pins)
  stage = 'socket_setup'
  console.log('Connecting ' + totalSockets + ' synthetic clients to ' + config.gateways + ' gateways')
  for (let id = 1; id <= totalSockets; id++) {
    const isOwner = id <= config.rooms
    const isMember = id > config.rooms && id <= config.rooms + config.multiRooms
    const room = isOwner ? id : isMember ? id - config.rooms : null
    const gateway = isMember ? room % config.gateways : (id - 1) % config.gateways
    clients.push(client(id, room ? 'fixture-room-' + room : null, gateway))
  }
  const plannedGateways = occupancy(clients.map((person) => ({
    ...person, socket: { readyState: WebSocket.OPEN, roomVerified: true, roomPhase: 'playing' },
  })), config.gateways, WebSocket.OPEN).gateways
  await batches(clients, config.joinConcurrency, async (person) => {
    const started = performance.now()
    try {
      const frame = await connect(person)
      setup.push({ kind: 'join', id: person.id, gateway: person.gateway, ms: performance.now() - started, ...frame })
    } catch (error) {
      setup.push({ kind: 'join', id: person.id, gateway: person.gateway, failure: errorTag(error) })
    }
  })
  report.successfulInitialJoins = setup.filter((row) => row.kind === 'join' && !row.failure).length
  report.initialOpenSockets = clients.filter((person) => person.socket?.readyState === WebSocket.OPEN).length
  workload.initial = sampleOccupancy('initial')
  workload.initial.plannedGateways = plannedGateways
  workload.initial.matchesPlannedGateways = plannedGateways.every((planned, index) =>
    planned.sockets === workload.initial.gateways[index].sockets && planned.rooms === workload.initial.gateways[index].rooms)
  assert(report.initialOpenSockets > 0, 'No synthetic clients joined')
  await sampleDatabase()
  stage = 'traffic'
  console.log('Running warmup then mixed traffic')
  const paced = (seconds, phase) => schedule(seconds * config.actionsPerSec, seconds * 1000, (index, at) => {
    const owner = owners()[(index + config.seed) % config.rooms]
    const limit = phase === 'paced' && owner.id % 8 === 1 && (index + Math.floor(index / config.rooms)) % 5 === 0
    return admit(owner, offer(owner, phase, (limit ? 'limit-' : '') + phase + '-' + index, at), 2800, false)
  })
  occupancyPhase = 'warmup'
  const warmupStarted = performance.now()
  sampleOccupancy(occupancyPhase, warmupStarted)
  await Promise.all([paced(config.warmupSec, 'warmup'), waitForWindowEnd(warmupStarted + config.warmupSec * 1000)])
  const warmupEnded = performance.now()
  sampleOccupancy(occupancyPhase, warmupEnded)
  workload.actual.warmupMs = warmupEnded - warmupStarted
  const readyReplicas = (role) => [...children].filter((entry) =>
    entry.role === role && entry.active && entry.ready && entry.child.connected).length
  report.scope.pacedReadyReplicas = {
    gateways: readyReplicas('gateway'), roomWorkers: readyReplicas('worker'), preparationWorkers: readyReplicas('prep'),
  }
  trafficStarted = performance.now()
  occupancyPhase = 'paced'
  workload.pacedStart = sampleOccupancy(occupancyPhase, trafficStarted)
  pacedTransports.established = workload.pacedStart.openSockets
  const duration = config.pacedSec * 1000
  const pacedWindow = waitForWindowEnd(trafficStarted + duration).then(() => {
    if (occupancyPhase !== 'paced') return
    const pacedEnded = performance.now()
    sampleOccupancy(occupancyPhase, pacedEnded)
    workload.actual.pacedMs = pacedEnded - trafficStarted
    occupancyPhase = 'recovery'
  })
  const mixed = paced(config.pacedSec, 'paced')
  const catalogWork = schedule(config.pacedSec * config.catalogPerSec, duration, (index) => browse(index, 'mixed'), trafficStarted)
  const regularImports = schedule(Math.ceil(config.pacedSec * config.importPerMinute / 60), duration,
    (index) => importStory(sourceCount + index + 1, 'paced'), trafficStarted)
  const importBurstStart = trafficStarted + Math.floor(duration * .18)
  const importBurstDuration = Math.min(60000, Math.floor(duration * .35))
  const importBurst = waitForWindowEnd(importBurstStart).then(() => schedule(config.importBurst,
    importBurstDuration, (index) => importStory(sourceCount + 1000 + index, 'burst'), importBurstStart))
  const actionBurstStart = trafficStarted + Math.floor(duration * .22)
  const actionBurstDuration = 1000
  const burst = waitForWindowEnd(actionBurstStart).then(async () => {
    let records = []
    await schedule(config.burst, actionBurstDuration, (index, at) => {
      const owner = owners()[index % config.rooms]
      const action = offer(owner, 'burst', 'burst-' + index, at)
      records.push(action)
      track(admit(owner, action, 25000))
    }, actionBurstStart)
    await waitForDurable(records, 29000, 'burst_terminal_timeout')
  })
  const reconnectWave = delay(Math.floor(duration * .25)).then(async () => {
    const started = performance.now()
    await batches(clients.filter((entry) => entry.room).slice(0, config.reconnect), config.joinConcurrency, (person) => {
      const survivors = activeGateways().filter((gate) => gate.index !== 0)
      const alternatives = survivors.filter((gate) => gate.index !== person.gateway)
      const destinations = alternatives.length ? alternatives : survivors
      return reconnect(person, destinations[(person.id - 1) % destinations.length].index,
        'client_wave', started, person.id % 2 ? 0 : person.seq)
    })
  })
  const gatewayRestart = delay(Math.floor(duration * .40)).then(restartGateway)
  const workerRestarts = delay(Math.floor(duration * .55)).then(restartRoomWorkers)
  await Promise.all([pacedWindow, mixed, catalogWork, regularImports, importBurst, burst, reconnectWave, gatewayRestart, workerRestarts])
  occupancyPhase = undefined
  const observedActions = [...actions.values()]
  const workloadWindows = {
    pacedActions: { rows: observedActions.filter((row) => row.phase === 'paced'), field: 'started', start: trafficStarted, length: duration },
    pacedImports: { rows: imports.filter((row) => row.phase === 'paced'), field: 'offeredAt', start: trafficStarted, length: duration },
    burstActions: { rows: observedActions.filter((row) => row.phase === 'burst'), field: 'started', start: actionBurstStart, length: actionBurstDuration },
    burstImports: { rows: imports.filter((row) => row.phase === 'burst'), field: 'offeredAt', start: importBurstStart, length: importBurstDuration },
  }
  const windows = Object.entries(workloadWindows)
  const offered = workload.offers = Object.fromEntries(windows.map(([key, { rows, field, start, length }]) =>
    [key, measureOffers(rows.map((row) => row[field]), start, length)]))
  workload.submissions = Object.fromEntries(windows.map(([key, { rows, start, length }]) =>
    [key, measureSubmissions(rows.map((row) => row.firstDispatchAt), start, length)]))
  Object.assign(workload.actual, {
    pacedActions: offered.pacedActions.withinWindow,
    burstActions: offered.burstActions.withinWindow,
    pacedImports: offered.pacedImports.withinWindow,
    burstImports: offered.burstImports.withinWindow,
    pacedActionOffersPerSecond: offered.pacedActions.offeredPerSecond,
    pacedImportOffersPerMinute: offered.pacedImports.offeredPerSecond * 60,
    reconnectClients: new Set(reconnects.filter((row) => row.phase === 'client_wave').map((row) => row.clientId)).size,
  })
  stage = 'reconcile'
  console.log('Reconciling receipts, room events, and preparation jobs')
  await Promise.allSettled(pendingTimers)
  await Promise.all([
    checkImports(imports.filter((row) => row.phase !== 'fixture'), 45000),
    waitForDurable([...actions.values()].filter((a) => a.ack !== undefined && a.terminal === undefined), 10000, 'final_pending_receipts'),
  ])
  await delay(600)
  report.integrity = await reconcile()
} catch (error) {
  setupFailure = { stage, code: errorTag(error) }
  console.error('Staging harness stopped during ' + stage + ' with ' + setupFailure.code)
  process.exitCode = 1
} finally {
  clearInterval(sampling)
  occupancyPhase = undefined
  report.setupFailure = setupFailure
  report.summary = summarizeActions()
  report.capacity = capacities()
  report.reconnect = Object.fromEntries(['client_wave', 'gateway_restart', 'worker_failover'].map((phase) => {
    const rows = reconnects.filter((row) => row.phase === phase)
    return [phase, {
      offered: rows.length, within30s: rows.filter((row) => row.ms <= 30000).length,
      failed: rows.filter((row) => row.failure).length,
      latency: percentile(rows.map((row) => row.ms)),
      snapshots: percentile(rows.filter((row) => row.type === 'room:state').map((row) => row.bytes)),
      replayResponses: rows.filter((row) => row.type === 'room:sync:done').length,
    }]
  }))
  report.catalog = {
    coldDefinition: 'first request to an owner during the workload; physical PostgreSQL cache was not flushed',
    firstObserved: percentile(catalog.filter((row) => !row.warm).map((row) => row.ms)),
    reusedOwner: percentile(catalog.filter((row) => row.warm).map((row) => row.ms)),
    laterPages: percentile(catalog.filter((row) => row.page === 'later').map((row) => row.ms)),
    failed: catalog.filter((row) => row.failure).length,
  }
  report.provider = { calls: provider.length, rateLimits: provider.filter((call) => call.rateLimit).length,
    serviceLatency: percentile(provider.map((call) => call.ms)) }
  report.assets = assets
  report.budgets = budgets()
  report.workload = { ...workload, sampledOccupancy: summarizeOccupancy(), ...referenceScorecard({
    ...workload, formats, samples: occupancySamples, scope: report.scope, setupFailure,
  }) }
  report.raw = { setup, imports, catalog, reconnects, actions: [...actions.values()], provider, samples, occupancySamples, failures }
  loop.disable()
  try {
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log('Synthetic report written to ' + output)
  } finally {
    for (const person of clients) {
      if (person.socket) {
        person.socket.intentional = true
        person.socket.terminate()
      }
    }
    await Promise.all([...children].map((entry) => stop(entry, 'SIGKILL')))
    await pool.end()
    s3.destroy()
    await rm(temp, { recursive: true, force: true })
  }
}
