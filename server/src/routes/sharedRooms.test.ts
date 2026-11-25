import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrl = process.env.TEST_SHARED_ROOMS_DATABASE_URL
const sheet = {
  playerName: 'Investigator',
  occupationName: 'Archivist',
  derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 50 },
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
  skills: {},
}

type Frame = {
  type: string
  seq?: number
  actionId?: string
  status?: string
  messageId?: string
  code?: string
  removedReason?: string
  error?: string
  snapshot?: { phase?: string; turnWindowMs?: number; messages?: { content: string }[]; kpMemory?: string[] }
  eventType?: string
  payload?: { message?: { role: string; content: string }; path?: string }
}
type Account = { token: string; user: { id: number; username: string } }

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('No TCP address'))
        else resolve(address.port)
      })
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

async function prepareDossier(root: string, userId: number, scriptId: string): Promise<void> {
  const directory = join(root, String(userId))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, randomUUID() + '.json'), JSON.stringify({
    scriptId,
    storyName: 'The Fog Archive',
    generatedAt: 100,
    quality: { degraded: false, coveragePct: 100, at: 100 },
    scenes: [{ id: 'archive', name: 'Archive', description: 'A dusty reading room', sceneText: 'The ledger is on the desk.' }],
    clues: [],
    npcs: [],
  }))
}

/** A controllable Keeper provider at the turn seam. The server, sockets and database remain real. */
interface KeeperFixture {
  pauseAfterTool?: boolean
  failOpeningCheckpoint?: boolean
  failOpeningProvider?: boolean
  endingOpeningBarrier?: string
  damageReleaseFile?: string
  ignoreLeaseRenewal?: boolean
}

function keeperFixture(options: KeeperFixture): string {
  const service = `
    import { existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const endingOpeningBarrier = ${JSON.stringify(options.endingOpeningBarrier)};
    const damageReleaseFile = ${JSON.stringify(options.damageReleaseFile)};
    let turns = 0;
    export async function runKpTurn(_userId, { messages }, turn) {
      if (${options.failOpeningProvider === true}) {
        turn.handlers.onError('Synthetic provider failure');
        return;
      }
      if (endingOpeningBarrier && ++turns === 1) {
        process.stdout.write('keeper fixture holding the only turn slot' + String.fromCharCode(10));
        while (!existsSync(endingOpeningBarrier)) await delay(20);
      } else if (endingOpeningBarrier && turns === 2) {
        turn.mutatorFactory(turn.activeCharacterId).endGame({
          outcome: 'closed', title: 'Archive closed', summary: 'The archive closes at the opening.',
        });
      }
      const damage = messages.findLast((message) => message.role === 'user')?.content.includes('Recover the damaged ledger');
      if (damage) {
        turn.mutatorFactory(turn.activeCharacterId).updateCharacterHP(-2);
        if (${options.pauseAfterTool === true}) {
          process.stdout.write('keeper fixture paused after HP tool' + String.fromCharCode(10));
          if (!damageReleaseFile) await new Promise(() => {});
          while (!existsSync(damageReleaseFile)) await delay(20);
        }
      }
      turn.handlers.onChunk?.('Narration chunk.');
      turn.handlers.onEnd({ content: damage ? 'The ledger was recovered.' : 'The archive is quiet.', displayMessages: [] });
    }
  `
  return 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module';
    const withFault = ${options.failOpeningCheckpoint === true};
    const ignoreLeaseRenewal = ${options.ignoreLeaseRenewal === true};
    const fixtureModule = (source) => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });
    registerHooks({
      resolve(specifier, context, next) {
        if (!context.parentURL?.endsWith('/roomService.ts')) return next(specifier, context);
        if (specifier === './kpTurnService.js') return fixtureModule(${JSON.stringify(service)});
        if (withFault && specifier === './roomMemory.js') {
          return fixtureModule("export async function extractMemoryPoints() { return ['The archive is silent']; }");
        }
        if (ignoreLeaseRenewal && specifier === './roomStorage.js') {
          const real = JSON.stringify(next(specifier, context).url);
          return fixtureModule('export * from ' + real + '; export async function renewRoomLease() { return true; }');
        }
        if (withFault && specifier === './roomStorage.js') {
          const real = JSON.stringify(next(specifier, context).url);
          return fixtureModule(
            'export * from ' + real + '; import { updateRoomStateSnapshot as write } from ' + real + ';' +
            'let failed = false;' +
            'export async function updateRoomStateSnapshot(roomId, state, phase, actions) {' +
            '  if (!failed && JSON.parse(state).messages?.some(m => m.content === "The archive is quiet.")) {' +
            '    failed = true; process.stdout.write("keeper fixture rejected the opening checkpoint" + String.fromCharCode(10));' +
            '    throw new Error("opening checkpoint unavailable");' +
            '  } return write(roomId, state, phase, actions);' +
            '}'
          );
        }
        return next(specifier, context);
      }
    });
  `)
}

/** Hold a particular submission immediately before its real database transaction. */
function pauseAcceptance(actionId: string): string {
  return 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        if (specifier !== './roomStorage.js' || !context.parentURL?.endsWith('/roomService.ts')) return resolved;
        const original = JSON.stringify(resolved.url);
        const targetId = ${JSON.stringify(actionId)};
        const wrapper = [
          'export * from ' + original + ';',
          'import { updateRoomStateSnapshot as write } from ' + original + ';',
          'export async function updateRoomStateSnapshot(...args) {',
          '  if (args[3]?.some((action) => action.actionId === ' + JSON.stringify(targetId) + ' && action.payloadHash)) {',
          '    process.stdout.write("chat fixture paused before commit" + String.fromCharCode(10));',
          '    await new Promise(() => {});',
          '  }',
          '  return write(...args);',
          '}',
        ].join(String.fromCharCode(10));
        return { url: 'data:text/javascript,' + encodeURIComponent(wrapper), shortCircuit: true };
      }
    });
  `)
}

/** Interrupt a single worker after it has authorized a REST mutation. */
function pauseRoomMutations(directory: string): string {
  return 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module';
    const directory = ${JSON.stringify(directory)};
    registerHooks({
      resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        if (specifier !== './roomStorage.js' || !context.parentURL?.endsWith('/roomService.ts')) return resolved;
        const origin = JSON.stringify(resolved.url);
        const wrapper = [
          'export * from ' + origin + ';',
          'import * as storage from ' + origin + ';',
          'import { existsSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'import { setTimeout as delay } from "node:timers/promises";',
          'const directory = ' + JSON.stringify(directory) + ';',
          'async function pause(operation) {',
          '  if (!existsSync(join(directory, "arm-" + operation))) return;',
          '  writeFileSync(join(directory, "held-" + operation), "");',
          '  while (!existsSync(join(directory, "release-" + operation))) await delay(20);',
          '}',
          'export async function insertMember(...args) { await pause("join"); return storage.insertMember(...args); }',
          'export async function transferRoomOwnership(...args) { await pause("transfer"); return storage.transferRoomOwnership(...args); }',
        ].join(String.fromCharCode(10));
        return { url: 'data:text/javascript,' + encodeURIComponent(wrapper), shortCircuit: true };
      }
    });
  `)
}

/** Simulate at-least-once outbox delivery while observing the public socket. */
function duplicateOutboxEvents(): string {
  const wrapper = [
    'export async function readRoomOutbox(...args) {',
    '  return (await read(...args)).map(room => ({',
    '    ...room, events: room.events.flatMap(event => [event, event]),',
    '  }));',
    '}',
  ].join('\n')
  return 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module'
    registerHooks({
      resolve(specifier, context, next) {
        const resolved = next(specifier, context)
        if (specifier !== '../services/roomService.js' || !context.parentURL?.endsWith('/gatewayRooms.ts')) return resolved
        const source = 'import { readRoomOutbox as read } from ' + JSON.stringify(resolved.url) + ';' + 'export { ROOM_EVENT_WINDOW } from ' + JSON.stringify(resolved.url) + ';' + ${JSON.stringify(wrapper)}
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
      },
    })
  `)
}

async function journey(backend: 'local' | 'postgres', scenario?: 'failover' | 'governance' | 'membership' | 'opening' | 'split' | 'history'): Promise<void> {
  const failover = scenario !== undefined

  const root = await mkdtemp(join(tmpdir(), 'aikp-room-journey-'))
  const fixtureRoot = join(root, 'prepared')
  const localDossiers = join(root, 'local-dossiers')
  const dataDir = join(root, 'sqlite')
  const jwtSecret = randomBytes(32).toString('hex')
  const children: ChildProcess[] = []
  const startupErrors = new WeakMap<ChildProcess, string>()
  const sockets: WebSocket[] = []
  const readyWorkers = new WeakSet<ChildProcess>()
  const pausedKeepers = new WeakSet<ChildProcess>()
  const rejectedOpenings = new WeakSet<ChildProcess>()
  const heldOpeningSlots = new WeakSet<ChildProcess>()
  const staleCheckpoints = new WeakSet<ChildProcess>()
  const pausedAcceptances = new WeakSet<ChildProcess>()
  const shared = backend === 'postgres'
  let base: string
  async function launch(options: KeeperFixture & { pauseActionId?: string; singleProcess?: boolean; chunkStream?: boolean; governanceBarrier?: string; runtime?: 'worker' | 'gateway'; activeRooms?: number; duplicateOutbox?: boolean } = {}): Promise<ChildProcess> {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    const args = ['--import', 'tsx']
    if (options.pauseAfterTool !== undefined || options.failOpeningCheckpoint || options.failOpeningProvider || options.endingOpeningBarrier) {
      args.push('--import', keeperFixture(options))
    }
    if (options.pauseActionId) args.push('--import', pauseAcceptance(options.pauseActionId))
    if (options.governanceBarrier) args.push('--import', pauseRoomMutations(options.governanceBarrier))
    if (options.duplicateOutbox) args.push('--import', duplicateOutboxEvents())
    args.push('src/app.ts')
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        TEST_SHARED_ROOMS_DATABASE_URL: undefined,
        DEPLOYMENT_MODE: shared ? 'shared-accounts' : 'local',
        ENABLE_SHARED_ROOMS: shared ? '1' : undefined,
        ENABLE_ROOM_WORKER_FAILOVER: failover && !options.singleProcess ? '1' : undefined,
        ROOM_WORKER_LEASE_MS: failover ? '3000' : undefined,
        ROOM_RUNTIME: options.runtime,
        ROOM_ACTIVE_INSTANCES: options.activeRooms?.toString(),
        SHARED_ROOM_FIXTURE_DIR: fixtureRoot,
        DATABASE_URL: shared ? databaseUrl : undefined,
        DATA_DIR: dataDir,
        DOSSIER_DATA_DIR: localDossiers,
        RAG_DATA_DIR: join(root, 'local-rag'),
        UPLOADS_DIR: join(root, 'uploads'),
        JWT_SECRET: jwtSecret,
        MOCK_AI: '1',
        KP_CHUNK_STREAM: options.chunkStream ? '1' : undefined,
        KP_ACTIVE_TURNS: options.endingOpeningBarrier ? '1' : undefined,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    if (options.runtime === 'worker' || options.pauseAfterTool || options.pauseActionId || options.failOpeningCheckpoint || options.endingOpeningBarrier) {
      let output = ''
      child.stdout?.on('data', (data: Buffer) => {
        output = (output + data.toString()).slice(-4_096)
        if (output.includes('Room worker ready')) readyWorkers.add(child)
        if (output.includes('keeper fixture paused after HP tool')) pausedKeepers.add(child)
        if (output.includes('keeper fixture rejected the opening checkpoint')) rejectedOpenings.add(child)
        if (output.includes('keeper fixture holding the only turn slot')) heldOpeningSlots.add(child)
        if (output.includes('chat fixture paused before commit')) pausedAcceptances.add(child)
      })
    } else child.stdout?.resume()
    if (options.ignoreLeaseRenewal) {
      child.stderr?.on('data', (data: Buffer) => {
        if (data.toString().includes('Room worker lease lost')) staleCheckpoints.add(child)
      })
    } else {
      child.stderr?.on('data', (data: Buffer) => {
        startupErrors.set(child, ((startupErrors.get(child) ?? '') + data.toString()).slice(-2_000))
      })
    }
    return child
  }
  async function ready(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && child.exitCode === null) {
      const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
      if (response?.ok) return
      await delay(50)
    }
    throw new Error(`${backend} gameplay process did not become ready (exit ${child.exitCode}): ${startupErrors.get(child) ?? ""}`)
  }
  async function request(path: string, options: { method?: string; token?: string; body?: unknown; expected?: number } = {}) {
    const headers: Record<string, string> = {}
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(base + path, {
      headers, method: options.method ?? 'GET', body: JSON.stringify(options.body), signal: AbortSignal.timeout(4_000),
    })
    const result = await response.json()
    expect(response.status, `${options.method ?? 'GET'} ${path}: ${String(result.error ?? '')}`).toBe(options.expected ?? 200)
    return result
  }
  async function register(): Promise<Account> {
    return request('/api/auth/register', {
      method: 'POST', body: { username: randomUUID().slice(0, 20), password: 'a-test-password' },
    })
  }
  async function connect(token: string, gateway = base) {
    const socket = new WebSocket(gateway.replace('http:', 'ws:') + '/ws?token=' + encodeURIComponent(token))
    sockets.push(socket)
    const frames: Frame[] = []
    const waiters = new Set<(frame: Frame) => void>()
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame
      frames.push(frame)
      for (const waiter of waiters) waiter(frame)
    })
    await once(socket, 'open')
    return {
      send: (frame: unknown) => socket.send(JSON.stringify(frame)),
      close: () => socket.close(),
      frames,
      async waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
        const existing = frames.find(predicate)
        if (existing) return existing
        const timeout = new Error('Missing room protocol frame')
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(waiter)
            const recent = frames.slice(-8).map(({ type, seq, error, removedReason }) => ({ type, seq, error, removedReason }))
            timeout.message = 'Missing protocol frame for ' + backend + ': ' + JSON.stringify(recent)
            reject(timeout)
          }, 8_000)
          const waiter = (frame: Frame) => {
            if (!predicate(frame)) return
            clearTimeout(timer)
            waiters.delete(waiter)
            resolve(frame)
          }
          waiters.add(waiter)
        })
      },
    }
  }
  const isKpMessage = (frame: Frame) => frame.eventType === 'message_appended' && frame.payload?.message?.role === 'kp'
  const chat = (roomId: string, content: string) => ({ type: 'room:action', roomId, action: { type: 'chat', payload: { content } } })
  const bind = (roomId: string, token: string, characterId: string, expected = 200) =>
    request(`/api/rooms/${roomId}/character`, { method: 'POST', token, expected, body: { characterId } })
  const detail = (roomId: string, token: string) => request(`/api/rooms/${roomId}`, { token })

  async function runSplitGateways(): Promise<void> {
    const worker = await launch({ runtime: 'worker', pauseAfterTool: false, activeRooms: 1 })
    await expect.poll(() => readyWorkers.has(worker), { timeout: 12_000 }).toBe(true)
    const first = await launch({ runtime: 'gateway', duplicateOutbox: true })
    await ready(first)
    const firstBase = base
    const owner = await register()
    const storyId = randomUUID()
    await prepareDossier(join(fixtureRoot, 'dossiers'), owner.user.id, storyId)
    const { roomId, inviteCode } = await request('/api/rooms', {
      method: 'POST', token: owner.token, body: { storyId, workflow: 'dossier' },
    })
    const second = await launch({ runtime: 'gateway' })
    await ready(second)
    const visitor = await register()
    const outsider = await register()
    expect(await request('/api/rooms/join', {
      method: 'POST', token: visitor.token, body: { inviteCode },
    })).toMatchObject({ roomId })
    for (const player of [owner, visitor]) {
      const { id } = await request('/api/characters', {
        method: 'POST', token: player.token, body: { name: 'Archivist', sheet },
      })
      await bind(roomId, player.token, id)
    }

    const socketA = await connect(owner.token, firstBase)
    const socketB = await connect(visitor.token)
    const blocked = await connect(outsider.token)
    const joinFrame = { type: 'room:join', roomId }
    socketA.send(joinFrame)
    expect(await socketA.waitFor((frame) => frame.type === 'room:state')).toMatchObject({ snapshot: { phase: 'lobby' } })
    socketB.send(joinFrame)
    expect(await socketB.waitFor((frame) => frame.type === 'room:state')).toMatchObject({ snapshot: { phase: 'lobby' } })
    blocked.send(joinFrame)
    expect(await blocked.waitFor((frame) => frame.type === 'room:error')).toMatchObject({ error: 'not a room member' })
    expect(blocked.frames.filter((frame) => frame.type === 'room:event' || frame.type === 'room:state')).toEqual([])

    const dormant = await request('/api/rooms', { method: 'POST', token: owner.token, body: {} })
    await enter(dormant.inviteCode, outsider.token)
    await request('/api/rooms/' + dormant.roomId + '/settings', {
      method: 'PUT', token: owner.token, body: { turnWindowMs: 900 },
    })
    expect(await detail(dormant.roomId, owner.token)).toMatchObject({ state: { turnWindowMs: 900 } })

    await enter(inviteCode, outsider.token)
    blocked.send(joinFrame)
    await blocked.waitFor((frame) => frame.type === 'room:state')
    await request('/api/rooms/' + roomId + '/members/' + outsider.user.id, { method: 'DELETE', token: owner.token })
    await blocked.waitFor((frame) => frame.type === 'room:error' && frame.removedReason === 'kicked')

    await request('/api/rooms/' + roomId + '/settings', {
      method: 'PUT', token: owner.token, body: { turnWindowMs: 0 },
    })
    await request('/api/rooms/' + roomId + '/start', {
      method: 'POST', token: owner.token, body: { storyId },
    })
    await Promise.all([socketA.waitFor(isKpMessage), socketB.waitFor(isKpMessage)])
    const beforeAction = socketA.frames.find(isKpMessage)?.seq ?? 0

    const actionId = randomUUID()
    const action = { ...chat(roomId, 'Recover the damaged ledger'), actionId }
    socketA.send(action)
    const receipt = await socketA.waitFor((frame) => frame.actionId === actionId)
    expect(receipt).toMatchObject({ status: 'pending', messageId: expect.any(String) })
    const recovered = (frame: Frame) => isKpMessage(frame) && frame.payload?.message?.content === 'The ledger was recovered.'
    const [firstEnd, secondEnd] = await Promise.all([socketA.waitFor(recovered), socketB.waitFor(recovered)])
    expect(firstEnd).toEqual(secondEnd)
    const committedTurn = (frames: Frame[]) =>
      frames.filter((frame) => frame.type === 'room:event' && (frame.seq ?? 0) > beforeAction && (frame.seq ?? 0) <= firstEnd.seq!)
    const turn = committedTurn(socketA.frames)
    expect(turn).toEqual(committedTurn(socketB.frames))
    const sequences = turn.map((frame) => frame.seq)
    expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a! - b!))
    expect(turn.filter((frame) => frame.payload?.message?.content === 'Recover the damaged ledger')).toHaveLength(1)
    expect(blocked.frames.some((frame) => (frame.seq ?? 0) > beforeAction)).toBe(false)

    const duplicate = await connect(owner.token)
    duplicate.send(joinFrame)
    expect(await duplicate.waitFor((frame) => frame.type === 'room:state')).toMatchObject({ kpTurnPending: false })
    duplicate.send(action)
    expect(await duplicate.waitFor((frame) => frame.actionId === actionId)).toMatchObject({
      status: 'completed', messageId: receipt.messageId,
    })
    expect(socketA.frames.filter((frame) => frame.payload?.message?.content === 'Recover the damaged ledger')).toHaveLength(1)
    await stop(worker)
    const unavailable = randomUUID()
    socketB.send({ ...chat(roomId, 'I cannot reach the worker'), actionId: unavailable })
    expect(await socketB.waitFor((frame) => frame.actionId === unavailable)).toMatchObject({ status: 'retry' })
    await request('/api/rooms/' + roomId + '/ready', {
      method: 'POST', token: visitor.token, body: { ready: true }, expected: 503,
    })
    const disconnected = await connect(visitor.token)
    const abandonedAction = randomUUID()
    const abandonedContent = 'This disconnected command must expire'
    const mailbox = new Pool({ connectionString: databaseUrl })
    const stillQueued = async () => (await mailbox.query(
      "SELECT 1 FROM room_commands WHERE room_id = $1 AND command->'args'->>1 = $2",
      [roomId, abandonedAction],
    )).rowCount
    try {
      disconnected.send({ ...chat(roomId, abandonedContent), actionId: abandonedAction })
      // Observe admission before severing the client connection. With no worker,
      // early removal is attributable to cancellation, not receipt consumption.
      await expect.poll(stillQueued, { timeout: 1_000 }).toBe(1)
      disconnected.close()
      await expect.poll(stillQueued, { timeout: 1_000 }).toBe(0)
    } finally {
      await mailbox.end()
    }

    const gatewayBase = base
    const replacement = await launch({ runtime: 'worker', pauseAfterTool: false })
    await expect.poll(() => readyWorkers.has(replacement), { timeout: 12_000 }).toBe(true)
    base = gatewayBase
    await stop(first)
    const restartedGateway = await launch({ runtime: 'gateway', duplicateOutbox: true })
    await ready(restartedGateway)
    const replay = await connect(owner.token)
    replay.send({ ...joinFrame, lastSeq: beforeAction })
    const replayDone = await replay.waitFor((frame) => frame.type === 'room:sync:done')
    expect(replayDone.seq).toBeGreaterThanOrEqual(firstEnd.seq!)
    expect(committedTurn(replay.frames)).toEqual(turn)
    expect(replay.frames.some((frame) => frame.type === 'room:state')).toBe(false)
    replay.send(action)
    expect(await replay.waitFor((frame) => frame.actionId === actionId)).toMatchObject({
      status: 'completed', messageId: receipt.messageId,
    })
    await request('/api/rooms/' + roomId + '/settings', {
      method: 'PUT', token: owner.token, body: { turnWindowMs: 125 },
    })
    const live = await replay.waitFor((frame) => frame.type === 'room:event' && frame.seq! > replayDone.seq!)
    expect(live.seq).toBe(replayDone.seq! + 1)

    const resumed = await connect(visitor.token)
    resumed.send(joinFrame)
    const resumedState = await resumed.waitFor((frame) => frame.type === 'room:state')
    expect(resumedState.snapshot?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'The ledger was recovered.' }),
    ]))
    const discarded = new Set(['I cannot reach the worker', abandonedContent])
    expect(resumedState.snapshot?.messages?.filter(({ content }) => discarded.has(content))).toEqual([])
  }

  async function runRoomHistory(): Promise<void> {
    const first = await launch()
    await ready(first)
    const owner = await register()
    const member = await register()
    const outsider = await register()
    const { roomId, inviteCode } = await request('/api/rooms', { method: 'POST', token: owner.token })
    const api = `/api/rooms/${roomId}/history`

    const legacy = Array.from({ length: 72 }, (_, index) => ({
      id: `legacy-${index}`, timestamp: 42, role: 'player', playerName: 'Archivist', content: `Ledger ${index}`,
    }))
    const pool = new Pool({ connectionString: databaseUrl })
    try {
      await pool.query("UPDATE rooms SET state = jsonb_set(state::jsonb, '{messages}', $2::jsonb)::text WHERE room_id = $1", [
        roomId, JSON.stringify(legacy),
      ])
    } finally {
      await pool.end()
    }

    expect(await request(api + '?limit=2', { token: owner.token })).toEqual({
      messages: legacy.slice(70), nextBefore: 'legacy-70',
    })
    await request(api, { token: outsider.token, expected: 404 })
    await request(api + '?limit=0', { token: owner.token, expected: 400 })
    await request('/api/rooms/join', { method: 'POST', token: member.token, body: { inviteCode } })
    expect((await request(api + '?limit=2', { token: member.token })).messages).toEqual(legacy.slice(70))

    const socket = await connect(owner.token)
    socket.send({ type: 'room:join', roomId })
    const state = await socket.waitFor((frame) => frame.type === 'room:state')
    const recent = state.snapshot?.messages ?? []
    expect(recent.map((message) => message.content)).toEqual(legacy.slice(-40).map((message) => message.content))
    expect(state.snapshot).toMatchObject({ transcript: { before: 'legacy-32' } })
    expect((await detail(roomId, owner.token)).state.messages).toHaveLength(40)

    const actionId = randomUUID()
    socket.send({ ...chat(roomId, 'File another ledger'), actionId })
    const receipt = await socket.waitFor((frame) => frame.actionId === actionId)
    expect(receipt.status).toBe('completed')
    await request(`/api/rooms/${roomId}/members/${member.user.id}`, { method: 'DELETE', token: owner.token })
    await request(api + '?before=legacy-71', { token: member.token, expected: 404 })
    await stop(first)
    const second = await launch()
    await ready(second)
    const page = await request(api + '?limit=2', { token: owner.token })
    expect(page).toMatchObject({
      messages: [legacy.at(-1), { id: receipt.messageId, content: 'File another ledger' }], nextBefore: 'legacy-71',
    })
    expect(await request(api + '?before=legacy-2&limit=2', { token: owner.token })).toEqual({
      messages: legacy.slice(0, 2), nextBefore: null,
    })
  }

  async function runWorkerFailover(): Promise<void> {
    const oldRelease = join(root, 'release-stale-provider')
    const oldest = await launch({ pauseAfterTool: true, damageReleaseFile: oldRelease, ignoreLeaseRenewal: true })
    await ready(oldest)
    const oldBase = base
    const exclusive = await launch({ singleProcess: true })
    await expect.poll(() => exclusive.exitCode, { timeout: 10_000 }).toBe(1)
    base = oldBase
    const owner = await register()
    const storyId = 'worker-failover-archive'
    await prepareDossier(join(fixtureRoot, 'dossiers'), owner.user.id, storyId)
    const createInvestigation = (name: string) => request('/api/rooms/solo', {
      method: 'POST', token: owner.token, body: { storyId, name, sheet, workflow: 'dossier' },
    })
    const staleRoom = await createInvestigation('Stale worker archivist')

    const waitingSocket = await connect(owner.token, oldBase)
    waitingSocket.send({ type: 'room:join', roomId: staleRoom.roomId })
    await waitingSocket.waitFor(isKpMessage)
    const actionText = 'Recover the damaged ledger'
    const staleActionId = randomUUID()
    const staleAction = { ...chat(staleRoom.roomId, actionText), actionId: staleActionId }
    waitingSocket.send(staleAction)
    const accepted = await waitingSocket.waitFor((frame) => frame.actionId === staleActionId)
    expect(accepted.status).toBe('pending')
    await expect.poll(() => pausedKeepers.has(oldest), { timeout: 7_000 }).toBe(true)

    const middle = await launch({ pauseAfterTool: true })
    await ready(middle)
    const middleBase = base
    const newest = await launch({ pauseAfterTool: false, chunkStream: true })
    await ready(newest)
    const newestBase = base
    await delay(3_100)
    const [claimA, claimB] = await Promise.all([connect(owner.token, middleBase), connect(owner.token, newestBase)])
    // The two processes try the same expired lease concurrently.
    for (const socket of [claimA, claimB]) socket.send({ type: 'room:join', roomId: staleRoom.roomId })
    const claims = await Promise.all([claimA, claimB].map((socket) => socket.waitFor((frame) => frame.type === 'room:state' || frame.type === 'room:error')))
    expect(claims.map((frame) => frame.type).sort()).toEqual(['room:error', 'room:state'])
    expect(claims.find((frame) => frame.type === 'room:error')?.error).toContain('房间正由另一进程处理')
    const winner = claims[1]?.type === 'room:state' ? claimB : claimA
    if (winner === claimA) {
      // A winner paused inside the provider is killed. A different process
      // must recover the same accepted action from its committed checkpoint.
      await expect.poll(() => pausedKeepers.has(middle), { timeout: 7_000 }).toBe(true)
      await stop(middle)
      await delay(3_100)
      claimB.send({ type: 'room:join', roomId: staleRoom.roomId })
    } else {
      await stop(middle)
    }
    await claimB.waitFor((frame) => frame.payload?.message?.content === 'The ledger was recovered.')
    await writeFile(oldRelease, '')
    await expect.poll(() => staleCheckpoints.has(oldest), { timeout: 7_000 }).toBe(true)
    const staleResult = await detail(staleRoom.roomId, owner.token)
    expect(staleResult.state.characters[staleRoom.characterId].derived.hp).toBe(8)
    expect(staleResult.state.messages.filter((message: { content: string }) => message.content === 'The ledger was recovered.')).toHaveLength(1)
    expect(waitingSocket.frames.some((frame) => frame.payload?.message?.content === 'The ledger was recovered.')).toBe(false)
    claimB.send(staleAction)
    expect(await claimB.waitFor((frame) => frame.actionId === staleActionId)).toMatchObject({ status: 'completed', messageId: accepted.messageId })
    expect(claimB.frames.some((frame) => frame.payload?.message?.content === actionText)).toBe(false)

    // Exercise a second, deterministic process death even if the first claim
    // race was won by the process with an immediate provider.
    const killRoom = await createInvestigation('Killed worker archivist')
    const killed = await launch({ pauseAfterTool: true })
    await ready(killed)
    const killedSocket = await connect(owner.token)
    killedSocket.send({ type: 'room:join', roomId: killRoom.roomId })
    await killedSocket.waitFor(isKpMessage)
    const killActionId = randomUUID()
    const killAction = { ...chat(killRoom.roomId, actionText), actionId: killActionId }
    killedSocket.send(killAction)
    const pending = await killedSocket.waitFor((frame) => frame.actionId === killActionId)
    expect(pending.status).toBe('pending')
    await expect.poll(() => pausedKeepers.has(killed), { timeout: 7_000 }).toBe(true)
    const nextActionId = randomUUID()
    killedSocket.send({ ...chat(killRoom.roomId, 'Count the shelves'), actionId: nextActionId })
    expect(await killedSocket.waitFor((frame) => frame.actionId === nextActionId)).toMatchObject({ status: 'pending' })
    const beforeKill = await detail(killRoom.roomId, owner.token)
    const turnId = beforeKill.state.pendingPlayerTurn?.id
    expect(turnId).toEqual(expect.any(String))
    expect(beforeKill.state.pendingPlayerTurn.actionCount).toBe(1)
    expect(beforeKill.state.characters[killRoom.characterId].derived.hp).toBe(10)
    await stop(killed)
    await delay(3_100)
    base = newestBase
    const resumed = await connect(owner.token)
    resumed.send({ type: 'room:join', roomId: killRoom.roomId })
    await resumed.waitFor((frame) => frame.payload?.message?.content === 'The ledger was recovered.')
    await resumed.waitFor((frame) => frame.payload?.message?.content === 'The archive is quiet.')
    const result = await detail(killRoom.roomId, owner.token)
    expect(result.state.characters[killRoom.characterId].derived.hp).toBe(8)
    expect(result.state.pendingTurnMessages).toEqual([])
    resumed.send(killAction)
    expect(await resumed.waitFor((frame) => frame.actionId === killActionId)).toMatchObject({ status: 'completed', messageId: pending.messageId })

    const database = new Pool({ connectionString: databaseUrl })
    try {
      const batches = await database.query(
        "SELECT turn_id, epoch::text, action_keys FROM room_turns WHERE room_id = $1 AND turn_id <> 'opening' ORDER BY first_event_seq",
        [killRoom.roomId],
      )
      expect(batches.rows).toEqual([
        { turn_id: turnId, epoch: '2', action_keys: [{ userId: owner.user.id, actionId: killActionId }] },
        { turn_id: expect.any(String), epoch: '2', action_keys: [{ userId: owner.user.id, actionId: nextActionId }] },
      ])
      const events = await database.query(
        `SELECT e.seq::int AS seq, e.event_type, e.payload, o.seq IS NOT NULL AS in_outbox
         FROM room_events e LEFT JOIN room_event_outbox o USING (room_id, seq)
         WHERE e.room_id = $1 ORDER BY e.seq`, [killRoom.roomId],
      )
      expect(events.rows.map((event) => event.seq)).toEqual(events.rows.map((_, index) => index + 1))
      expect(events.rows.every((event) => event.in_outbox)).toBe(true)
      expect(events.rows.filter((event) => event.event_type === 'kp_chunk')).toHaveLength(2)
      expect(events.rows.filter((event) => event.payload?.message?.content === actionText)).toHaveLength(1)
      expect(events.rows.filter((event) => event.payload?.message?.content === 'The ledger was recovered.')).toHaveLength(1)
    } finally {
      await database.end()
    }
  }

  async function createLobby(owner: Account, name: string) {
    const storyId = 'worker-' + randomUUID()
    await prepareDossier(join(fixtureRoot, 'dossiers'), owner.user.id, storyId)
    const room = await request('/api/rooms', {
      method: 'POST', token: owner.token, body: { storyId, workflow: 'dossier' },
    })
    const addCard = async (account: Account, cardName: string) => {
      const card = await request('/api/characters', { method: 'POST', token: account.token, body: { name: cardName, sheet } })
      await bind(room.roomId, account.token, card.id)
      return card.id
    }
    const characterId = await addCard(owner, name)
    return { ...room, storyId, characterId, addCard }
  }

  const enter = (inviteCode: string, token: string, expected = 200) =>
    request('/api/rooms/join', { method: 'POST', token, body: { inviteCode }, expected })

  async function runGovernanceRace() {
    const slow = await launch({ governanceBarrier: root })
    await ready(slow)
    const slowBase = base
    const fast = await launch()
    await ready(fast)
    const fastBase = base
    const owner = await register()
    const member = await register()
    const other = await register()
    const room = await createLobby(owner, 'Governance archivist')
    const start = (expected: number) => request('/api/rooms/' + room.roomId + '/start', {
      method: 'POST', token: owner.token, body: { storyId: room.storyId }, expected,
    })
    const transfer = (userId: number, expected = 200) => request('/api/rooms/' + room.roomId + '/transfer', {
      method: 'POST', token: owner.token, body: { userId }, expected,
    })

    await writeFile(join(root, 'arm-join'), '')
    base = slowBase
    const joining = enter(room.inviteCode, member.token)
    try {
      await expect.poll(() => existsSync(join(root, 'held-join'))).toBe(true)
      base = fastBase
      await start(503)
    } finally {
      await writeFile(join(root, 'release-join'), '')
      await joining
    }
    await start(409)
    await enter(room.inviteCode, other.token)
    await writeFile(join(root, 'arm-transfer'), '')
    base = slowBase
    const transferring = transfer(member.user.id)
    try {
      await expect.poll(() => existsSync(join(root, 'held-transfer'))).toBe(true)
      base = fastBase
      await transfer(other.user.id, 503)
    } finally {
      await writeFile(join(root, 'release-transfer'), '')
      await transferring
    }
    await transfer(other.user.id, 409)
    const snapshot = await detail(room.roomId, member.token)
    expect(snapshot.members.filter((entry: { role: string }) => entry.role === 'owner')).toMatchObject([{ userId: member.user.id }])
  }

  async function runMembershipRecovery() {
    const worker = await launch({ pauseAfterTool: true })
    await ready(worker)
    const owner = await register()
    const removed = await register()
    const room = await createLobby(owner, 'Recovery owner')
    await enter(room.inviteCode, removed.token)
    await room.addCard(removed, 'Recovery member')
    await request('/api/rooms/' + room.roomId + '/settings', { method: 'PUT', token: owner.token, body: { turnWindowMs: 800 } })
    await request('/api/rooms/' + room.roomId + '/start', { method: 'POST', token: owner.token, body: { storyId: room.storyId } })

    const ownerSocket = await connect(owner.token)
    const removedSocket = await connect(removed.token)
    for (const socket of [ownerSocket, removedSocket]) socket.send({ type: 'room:join', roomId: room.roomId })
    await Promise.all([ownerSocket, removedSocket].map((socket) => socket.waitFor((frame) => frame.type === 'room:state')))
    const removedId = randomUUID()
    const survivingId = randomUUID()
    removedSocket.send({ ...chat(room.roomId, 'Look at the rug'), actionId: removedId })
    expect(await removedSocket.waitFor((frame) => frame.actionId === removedId)).toMatchObject({ status: 'pending' })
    ownerSocket.send({ ...chat(room.roomId, 'Recover the damaged ledger'), actionId: survivingId })
    expect(await ownerSocket.waitFor((frame) => frame.actionId === survivingId)).toMatchObject({ status: 'pending' })
    await expect.poll(() => pausedKeepers.has(worker), { timeout: 7_000 }).toBe(true)
    const original = (await detail(room.roomId, owner.token)).state.pendingPlayerTurn
    expect(original).toMatchObject({ id: expect.any(String), actionCount: 2 })
    await stop(worker)

    const replacement = await launch({ pauseAfterTool: false })
    await ready(replacement)
    await delay(3_100)
    await request('/api/rooms/' + room.roomId + '/members/' + removed.user.id, { method: 'DELETE', token: owner.token })
    const resumed = await connect(owner.token)
    resumed.send({ type: 'room:join', roomId: room.roomId })
    await resumed.waitFor((frame) => frame.payload?.message?.content === 'The ledger was recovered.')
    expect((await detail(room.roomId, owner.token)).state.characters[room.characterId].derived.hp).toBe(8)

    const database = new Pool({ connectionString: databaseUrl })
    try {
      const turns = await database.query(
        "SELECT turn_id, action_keys, outcome FROM room_turns WHERE room_id = $1 AND turn_id <> 'opening' ORDER BY first_event_seq NULLS FIRST",
        [room.roomId],
      )
      expect(turns.rows).toEqual([
        { turn_id: original.id, action_keys: [{ userId: removed.user.id, actionId: removedId }, { userId: owner.user.id, actionId: survivingId }], outcome: 'cancelled' },
        { turn_id: expect.any(String), action_keys: [{ userId: owner.user.id, actionId: survivingId }], outcome: 'completed' },
      ])
      expect(turns.rows[1].turn_id).not.toBe(original.id)
      expect((await database.query('SELECT status FROM room_actions WHERE room_id = $1 AND action_id = $2', [room.roomId, removedId])).rows).toEqual([{ status: 'cancelled' }])
    } finally {
      await database.end()
    }
  }

  async function runOpeningRetry() {
    const first = await launch({ failOpeningProvider: true })
    await ready(first)
    const owner = await register()
    const storyId = 'opening-failure-archive'
    await prepareDossier(join(fixtureRoot, 'dossiers'), owner.user.id, storyId)
    const room = await request('/api/rooms/solo', {
      method: 'POST', token: owner.token, body: { storyId, name: 'Opening retry archivist', sheet, workflow: 'dossier' },
    })
    const initial = await connect(owner.token)
    initial.send({ type: 'room:join', roomId: room.roomId })
    await initial.waitFor((frame) => frame.payload?.message?.role === 'system')
    await stop(first)

    const second = await launch({ pauseAfterTool: false })
    await ready(second)
    await delay(3_100)
    const resumed = await connect(owner.token)
    resumed.send({ type: 'room:join', roomId: room.roomId })
    await resumed.waitFor(isKpMessage)

    const database = new Pool({ connectionString: databaseUrl })
    try {
      const attempts = await database.query('SELECT turn_id, outcome FROM room_turns WHERE room_id = $1 ORDER BY first_event_seq', [room.roomId])
      expect(attempts.rows).toEqual([
        { turn_id: expect.stringMatching(/^opening-failed:/), outcome: 'failed' },
        { turn_id: 'opening', outcome: 'completed' },
      ])
    } finally {
      await database.end()
    }
  }

  try {
    if (scenario === 'split') return await runSplitGateways()
    if (scenario === 'history') return await runRoomHistory()
    if (scenario === 'governance') return await runGovernanceRace()
    if (scenario === 'membership') return await runMembershipRecovery()
    if (scenario === 'opening') return await runOpeningRetry()
    if (scenario === 'failover') return await runWorkerFailover()
    const beforeCommitId = randomUUID()
    let first = await launch({ pauseActionId: beforeCommitId })
    await ready(first)
    if (shared) {
      const firstBase = base!
      const competing = await launch()
      await expect.poll(() => competing.exitCode, { timeout: 10_000 }).toBe(1)
      expect(await fetch(base! + '/health/ready', { signal: AbortSignal.timeout(1_000) }).catch(() => null)).toBeNull()
      base = firstBase
    }
    const originalOwner = await register()
    const host = await register()
    const outsider = await register()
    const storyId = 'fog-archive'
    const fixtures = shared ? join(fixtureRoot, 'dossiers') : localDossiers
    await prepareDossier(fixtures, originalOwner.user.id, storyId)
    if (shared) {
      await prepareDossier(localDossiers, originalOwner.user.id, 'local-only')
      await request('/api/rooms/solo', {
        method: 'POST', token: originalOwner.token, expected: 409,
        body: { storyId: 'local-only', name: 'First investigator', sheet, workflow: 'dossier' },
      })
    }

    const solo = await request('/api/rooms/solo', {
      method: 'POST', token: originalOwner.token, body: { storyId, name: 'First investigator', sheet, workflow: 'dossier' },
    })
    expect(await request('/api/characters', { token: originalOwner.token })).toContainEqual(
      expect.objectContaining({ id: solo.characterId, name: 'First investigator' }),
    )
    let soloSocket = await connect(originalOwner.token)
    soloSocket.send({ type: 'room:join', roomId: solo.roomId })
    expect((await soloSocket.waitFor((frame) => frame.type === 'room:state')).snapshot).toMatchObject({
      phase: 'playing', turnWindowMs: 0,
    })
    const opening = await soloSocket.waitFor(isKpMessage)
    if (shared) {
      await stop(first)
      first = await launch({ pauseActionId: beforeCommitId })
      await ready(first)
      soloSocket = await connect(originalOwner.token)
      soloSocket.send({ type: 'room:join', roomId: solo.roomId })
      const restored = await soloSocket.waitFor((frame) => frame.type === 'room:state')
      expect(restored.seq).toBeGreaterThanOrEqual(opening.seq!)
      expect(restored.snapshot?.messages).toContainEqual(
        expect.objectContaining({ role: 'kp', content: opening.payload?.message?.content }),
      )
      expect(restored.snapshot?.kpMemory?.length).toBeGreaterThan(0)
    }
    const soloAction = 'Search the ledger drawer'
    soloSocket.send(chat(solo.roomId, soloAction))
    await expect.poll(() => soloSocket.frames.filter(isKpMessage).length, { timeout: 8_000 }).toBe(shared ? 1 : 2)

    const beforeCommitText = 'Read the filing instructions'
    const beforeCommit = { ...chat(solo.roomId, beforeCommitText), actionId: beforeCommitId }
    soloSocket.send(beforeCommit)
    await expect.poll(() => pausedAcceptances.has(first), { timeout: 7_000 }).toBe(true)
    expect(soloSocket.frames.some((frame) => frame.actionId === beforeCommitId || frame.payload?.message?.content === beforeCommitText)).toBe(false)
    await stop(first)
    first = await launch()
    await ready(first)
    soloSocket = await connect(originalOwner.token)
    soloSocket.send({ type: 'room:join', roomId: solo.roomId })
    const beforeRetry = await soloSocket.waitFor((frame) => frame.type === 'room:state')
    expect(beforeRetry.snapshot?.messages?.some((message) => message.content === beforeCommitText)).toBe(false)
    soloSocket.send(beforeCommit)
    expect(await soloSocket.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === beforeCommitId)).toMatchObject({
      status: 'pending', messageId: expect.any(String),
    })
    await soloSocket.waitFor(isKpMessage)
    expect(soloSocket.frames.filter((frame) => frame.payload?.message?.content === beforeCommitText)).toHaveLength(1)

    const lobby = await request('/api/rooms', {
      method: 'POST', token: originalOwner.token, body: { storyId, workflow: 'dossier' },
    })
    const roomId: string = lobby.roomId
    expect(lobby.inviteCode).toMatch(/^[A-Z0-9]{6}$/)
    await request('/api/rooms/join', { method: 'POST', token: host.token, body: { inviteCode: lobby.inviteCode } })
    await request('/api/rooms/join', { method: 'POST', token: host.token, body: { inviteCode: lobby.inviteCode } })
    await request(`/api/rooms/${roomId}`, { token: outsider.token, expected: 404 })
    const hostCard = await request('/api/characters', {
      method: 'POST', token: host.token, body: { name: 'Second investigator', sheet },
    })
    await bind(roomId, host.token, solo.characterId, 404)
    await Promise.all([bind(roomId, originalOwner.token, solo.characterId), bind(roomId, host.token, hostCard.id)])
    await request(`/api/rooms/${roomId}/ready`, { method: 'POST', token: host.token, body: { ready: true } })

    const [ownerSocket, hostSocket] = await Promise.all([connect(originalOwner.token), connect(host.token)])
    ownerSocket.send({ type: 'room:join', roomId })
    hostSocket.send({ type: 'room:join', roomId })
    await Promise.all([ownerSocket, hostSocket].map(async (socket) => {
      expect((await socket.waitFor((frame) => frame.type === 'room:state')).snapshot?.phase).toBe('lobby')
    }))
    ownerSocket.send(chat(roomId, 'Lobby discussion'))
    await hostSocket.waitFor((frame) => frame.payload?.message?.content === 'Lobby discussion')
    expect(hostSocket.frames.some(isKpMessage)).toBe(false)

    const lobbyActionId = randomUUID()
    const lobbyAction = { ...chat(roomId, '  File the briefing  '), actionId: lobbyActionId }
    ownerSocket.send(lobbyAction)
    const lobbyReceipt = await ownerSocket.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === lobbyActionId)
    expect(lobbyReceipt).toMatchObject({ status: 'completed', messageId: expect.any(String) })
    expect((await detail(roomId, host.token)).state.messages).toContainEqual(
      expect.objectContaining({ id: lobbyReceipt.messageId, content: 'File the briefing' }),
    )
    const receiptCount = () => ownerSocket.frames.filter((frame) => frame.type === 'room:action:result' && frame.actionId === lobbyActionId).length
    ownerSocket.send({ ...chat(roomId, 'File the briefing'), actionId: lobbyActionId })
    await expect.poll(receiptCount).toBe(2)
    ownerSocket.send({ ...chat(roomId, 'Replace the briefing'), actionId: lobbyActionId })
    await expect.poll(receiptCount).toBe(3)
    expect(ownerSocket.frames.filter((frame) => frame.type === 'room:action:result' && frame.actionId === lobbyActionId).slice(1)).toMatchObject([
      { status: 'completed', messageId: lobbyReceipt.messageId },
      { status: 'rejected', code: 'action_conflict' },
    ])
    expect(hostSocket.frames.filter((frame) => frame.payload?.message?.content === 'File the briefing')).toHaveLength(1)
    expect(hostSocket.frames.some((frame) => frame.type === 'room:action:result')).toBe(false)

    await request(`/api/rooms/${roomId}/transfer`, {
      method: 'POST', token: originalOwner.token, body: { userId: host.user.id },
    })
    await request(`/api/rooms/${roomId}/start`, { method: 'POST', token: host.token, body: { storyId } })
    await request(`/api/rooms/${roomId}/settings`, { method: 'PUT', token: host.token, body: { turnWindowMs: 0 } })
    hostSocket.send(chat(roomId, 'Inspect the reading room'))
    await ownerSocket.waitFor(isKpMessage)
    await hostSocket.waitFor(isKpMessage)
    expect(ownerSocket.frames.filter(isKpMessage)).toHaveLength(1)
    await request(`/api/rooms/${roomId}/settings`, { method: 'PUT', token: host.token, body: { turnWindowMs: 60_000 } })
    const pendingAction = 'Open the archive cabinet'
    const pendingActionId = randomUUID()
    const pendingFrame = { ...chat(roomId, pendingAction), actionId: pendingActionId }
    hostSocket.send(pendingFrame)
    const pendingReceipt = await hostSocket.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === pendingActionId)
    expect(pendingReceipt).toMatchObject({ status: 'pending', messageId: expect.any(String) })
    await ownerSocket.waitFor((frame) => frame.payload?.message?.content === pendingAction)

    for (let i = 0; i < 31; i++) {
      const actionId = randomUUID()
      hostSocket.send({ ...chat(roomId, 'Review archive item ' + i), actionId })
      expect(await hostSocket.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === actionId)).toMatchObject({ status: 'pending' })
    }
    const busyActionId = randomUUID()
    const busyFrame = { ...chat(roomId, 'Review the overflow file'), actionId: busyActionId }
    hostSocket.send(busyFrame)
    expect(await hostSocket.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === busyActionId)).toMatchObject({ status: 'busy', code: 'room_busy' })
    hostSocket.send(pendingFrame)
    await expect.poll(() => hostSocket.frames.filter((frame) => frame.actionId === pendingActionId).length).toBe(2)
    expect(hostSocket.frames.filter((frame) => frame.actionId === pendingActionId).at(-1)).toMatchObject({ status: 'pending', messageId: pendingReceipt.messageId })
    expect(ownerSocket.frames.filter((frame) => frame.payload?.message?.content === pendingAction)).toHaveLength(1)


    // Kill the whole gameplay process while the action is pending so that
    // transport cleanup cannot masquerade as the host leaving the room.
    await stop(first)
    const restarted = await launch()
    await ready(restarted)
    const persisted = await detail(roomId, host.token)
    expect(persisted).toMatchObject({
      roomId, ownerId: host.user.id, storyId, phase: 'playing',
      state: { workflow: 'dossier', turnWindowMs: 60_000, pendingTurnMessages: expect.arrayContaining([expect.objectContaining({ authorUserId: host.user.id, characterId: hostCard.id, content: pendingAction, actionId: pendingActionId })]) },
    })
    expect(persisted.members).toHaveLength(2)
    expect(persisted.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: host.user.id, role: 'owner', characterId: hostCard.id, ready: false }),
      expect.objectContaining({ userId: originalOwner.user.id, role: 'member', characterId: solo.characterId }),
    ]))
    expect(await request('/api/rooms/solo', { token: originalOwner.token })).toMatchObject([{ roomId: solo.roomId }])
    expect(await request('/api/rooms', { token: originalOwner.token })).toMatchObject([{ roomId }])
    await request(`/api/rooms/${roomId}/settings`, { method: 'PUT', token: originalOwner.token, expected: 409, body: { turnWindowMs: 0 } })
    await request(`/api/rooms/${roomId}/start`, { method: 'POST', token: host.token, body: { storyId } })

    const [resumedHost, resumedOwner] = await Promise.all([connect(host.token), connect(originalOwner.token)])
    resumedHost.send({ type: 'room:join', roomId })
    resumedOwner.send({ type: 'room:join', roomId })
    for (const socket of [resumedHost, resumedOwner]) {
      const frame = await socket.waitFor((frame) => frame.type === 'room:state')
      expect(frame.snapshot).toMatchObject({ phase: 'playing', turnWindowMs: 60_000 })
      expect(frame.snapshot?.messages?.filter((message) => message.content === pendingAction)).toHaveLength(1)
    }
    expect((await resumedHost.waitFor(isKpMessage)).seq).toBeGreaterThan(persisted.state.seq)
    await expect.poll(async () => (await detail(roomId, host.token)).state.pendingTurnMessages).toEqual([])
    resumedHost.send(pendingFrame)
    expect(await resumedHost.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === pendingActionId)).toMatchObject({
      status: 'completed', messageId: pendingReceipt.messageId,
    })
    expect(resumedHost.frames.filter((frame) => frame.payload?.message?.content === pendingAction)).toHaveLength(0)
    expect(resumedHost.frames.every((frame) => frame.payload?.message?.content !== 'Review the overflow file')).toBe(true)
    const progressed = await detail(roomId, host.token)
    expect(progressed.state.messages.filter((message: { role: string }) => message.role === 'kp')).toHaveLength(2)
    expect(progressed.state.seq).toBeGreaterThan(persisted.state.seq)

    const resumedSolo = await connect(originalOwner.token)
    resumedSolo.send({ type: 'room:join', roomId: solo.roomId })
    expect((await resumedSolo.waitFor((frame) => frame.type === 'room:state')).snapshot).toMatchObject({
      phase: 'playing', turnWindowMs: 0, messages: expect.arrayContaining([expect.objectContaining({ content: soloAction })]),
    })
    resumedSolo.send(chat(solo.roomId, 'Check the cabinet lock'))
    await resumedSolo.waitFor(isKpMessage)
    {
      await request(`/api/rooms/${roomId}/settings`, { method: 'PUT', token: host.token, body: { turnWindowMs: 60_000 } })
      const revokedActionId = randomUUID()
      const revokedText = 'Take the sealed letter'
      const revokedFrame = { ...chat(roomId, revokedText), actionId: revokedActionId }
      resumedOwner.send(revokedFrame)
      expect(await resumedOwner.waitFor((frame) => frame.actionId === revokedActionId)).toMatchObject({ status: 'pending' })
      await request(`/api/rooms/${roomId}/members/${originalOwner.user.id}`, { method: 'DELETE', token: host.token })
      resumedOwner.send(revokedFrame)
      expect(await resumedOwner.waitFor((frame) => frame.actionId === revokedActionId && frame.status === 'rejected')).toMatchObject({ code: 'not_member' })
      await request(`/api/rooms/${roomId}`, { token: originalOwner.token, expected: 404 })

      await stop(restarted)
      const interrupted = await launch({ pauseAfterTool: true })
      await ready(interrupted)
      const currentMember = await connect(host.token)
      currentMember.send({ type: 'room:join', roomId })
      await currentMember.waitFor((frame) => frame.type === 'room:state')
      await expect.poll(async () => (await detail(roomId, host.token)).state.pendingTurnMessages).toEqual([])
      expect(currentMember.frames.some(isKpMessage)).toBe(false)

      const live = await connect(originalOwner.token)
      live.send({ type: 'room:join', roomId: solo.roomId })
      await live.waitFor((frame) => frame.type === 'room:state')
      const damageAction = 'Recover the damaged ledger'
      const damageActionId = randomUUID()
      const damageFrame = { ...chat(solo.roomId, damageAction), actionId: damageActionId }
      live.send(damageFrame)
      const damageReceipt = await live.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === damageActionId)
      expect(damageReceipt.status).toBe('pending')
      await expect.poll(() => pausedKeepers.has(interrupted), { timeout: 7_000 }).toBe(true)

      // A subsequent accepted chat commits its own checkpoint while the first
      // Keeper call is paused. It must not save the first call's staged tool effects.
      const nextAction = 'Catalog the shelves'
      live.send(chat(solo.roomId, nextAction))
      await live.waitFor((frame) => frame.payload?.message?.content === nextAction)
      expect(live.frames.some((frame) => frame.payload?.path === `characters.${solo.characterId}`)).toBe(false)
      const beforeKill = await detail(solo.roomId, originalOwner.token)
      expect(beforeKill.state.characters[solo.characterId].derived.hp).toBe(10)
      expect(beforeKill.state.pendingTurnMessages.map((message: { content: string }) => message.content)).toEqual([damageAction, nextAction])

      await stop(interrupted)
      const recovered = await launch({ pauseAfterTool: false })
      await ready(recovered)
      const afterCrash = await connect(originalOwner.token)
      afterCrash.send({ type: 'room:join', roomId: solo.roomId })
      await afterCrash.waitFor((frame) => frame.payload?.message?.content === 'The ledger was recovered.')
      const resolved = await detail(solo.roomId, originalOwner.token)
      expect(resolved.state.characters[solo.characterId].derived.hp).toBe(8)
      expect(resolved.state.pendingTurnMessages).toEqual([])
      expect(resolved.state.messages.filter((message: { content: string }) => message.content === 'The ledger was recovered.')).toHaveLength(1)
      afterCrash.send(damageFrame)
      expect(await afterCrash.waitFor((frame) => frame.type === 'room:action:result' && frame.actionId === damageActionId)).toMatchObject({
        status: 'completed', messageId: damageReceipt.messageId,
      })
      expect(afterCrash.frames.filter((frame) => frame.payload?.message?.content === damageAction)).toHaveLength(0)
      if (shared) {
        await stop(recovered)
        const retryServer = await launch({ failOpeningCheckpoint: true })
        await ready(retryServer)
        const fresh = await request('/api/rooms/solo', {
          method: 'POST', token: originalOwner.token, body: { storyId, name: 'Retry investigator', sheet, workflow: 'dossier' },
        })
        const retrySocket = await connect(originalOwner.token)
        retrySocket.send({ type: 'room:join', roomId: fresh.roomId })
        await retrySocket.waitFor((frame) => frame.type === 'room:state')
        await expect.poll(() => rejectedOpenings.has(retryServer), { timeout: 7_000 }).toBe(true)
        const beforeRetry = await detail(fresh.roomId, originalOwner.token)
        expect(beforeRetry.state.messages ?? []).toEqual([])
        expect(retrySocket.frames.filter(isKpMessage)).toHaveLength(0)
        retrySocket.send({ type: 'room:action', roomId: fresh.roomId, action: { type: 'retry_kp' } })
        await retrySocket.waitFor(isKpMessage)
        await expect.poll(async () => (await detail(fresh.roomId, originalOwner.token)).state.kpMemory).toEqual(['The archive is silent'])
        expect(retrySocket.frames.filter(isKpMessage)).toHaveLength(1)
        expect(existsSync(dataDir)).toBe(false)
      } else {
        await stop(recovered)
        const releaseOpening = join(root, 'release-opening')
        const openingServer = await launch({ endingOpeningBarrier: releaseOpening })
        await ready(openingServer)
        const createInvestigation = (name: string) => request('/api/rooms/solo', {
          method: 'POST', token: originalOwner.token, body: { storyId, name, sheet, workflow: 'dossier' },
        })
        const blocking = await createInvestigation('Turn slot holder')
        const closing = await createInvestigation('Closing archive investigator')
        const blockingSocket = await connect(originalOwner.token)
        blockingSocket.send({ type: 'room:join', roomId: blocking.roomId })
        await expect.poll(() => heldOpeningSlots.has(openingServer), { timeout: 7_000 }).toBe(true)

        const closingSocket = await connect(originalOwner.token)
        closingSocket.send({ type: 'room:join', roomId: closing.roomId })
        await closingSocket.waitFor((frame) => frame.type === 'room:state')
        const actionId = randomUUID()
        const action = { ...chat(closing.roomId, 'Inspect the closed archive'), actionId }
        closingSocket.send(action)
        const receipt = await closingSocket.waitFor((frame) => frame.actionId === actionId)
        expect(receipt).toMatchObject({ status: 'pending', messageId: expect.any(String) })

        await writeFile(releaseOpening, '')
        await closingSocket.waitFor((frame) => frame.payload?.path === 'ending')
        expect(await detail(closing.roomId, originalOwner.token)).toMatchObject({
          phase: 'ended', state: { pendingTurnMessages: [], ending: { title: 'Archive closed' } },
        })
        closingSocket.send(action)
        await expect.poll(() => closingSocket.frames.filter((frame) => frame.actionId === actionId).length).toBe(2)
        expect(closingSocket.frames.filter((frame) => frame.actionId === actionId).at(-1)).toMatchObject({
          status: 'cancelled', messageId: receipt.messageId,
        })
        expect(closingSocket.frames.filter((frame) => frame.payload?.message?.content === 'Inspect the closed archive')).toHaveLength(1)
      }
    }
  } finally {
    await Promise.all(children.map(stop))
    sockets.forEach((socket) => socket.terminate())
    await rm(root, { recursive: true, force: true })
  }
}

describe('room protocol across a gameplay process restart', () => {
  it('creates and resumes solo and multiplayer investigations in SQLite', () => journey('local'), 90_000)
  it.skipIf(!databaseUrl)('runs the same solo and multiplayer investigations in PostgreSQL', () => journey('postgres'), 90_000)
  it.skipIf(!databaseUrl)('fences stale Keeper effects and recovers accepted turns across PostgreSQL workers', () => journey('postgres', 'failover'), 90_000)
  it.skipIf(!databaseUrl)('serializes competing REST authorizations on an inactive room', () => journey('postgres', 'governance'), 45_000)
  it.skipIf(!databaseUrl)('cancels the original recovered turn when a member was removed', () => journey('postgres', 'membership'), 45_000)
  it.skipIf(!databaseUrl)('retries an effect-free failed opening after worker restart', () => journey('postgres', 'opening'), 45_000)
  it.skipIf(!databaseUrl)('routes play through two gateways and a dedicated PostgreSQL worker', () => journey('postgres', 'split'), 70_000)
  it.skipIf(!databaseUrl)('resumes with bounded state and pages earlier transcript in committed order', () => journey('postgres', 'history'), 45_000)
})
