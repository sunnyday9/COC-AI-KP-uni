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
}

function keeperFixture(options: KeeperFixture): string {
  const service = `
    export async function runKpTurn(_userId, { messages }, turn) {
      const damage = JSON.stringify(messages).includes('Recover the damaged ledger');
      if (damage) {
        turn.mutatorFactory(turn.activeCharacterId).updateCharacterHP(-2);
        if (${options.pauseAfterTool === true}) {
          process.stdout.write('keeper fixture paused after HP tool' + String.fromCharCode(10));
          await new Promise(() => {});
        }
      }
      turn.handlers.onEnd({ content: damage ? 'The ledger was recovered.' : 'The archive is quiet.', displayMessages: [] });
    }
  `
  return 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module';
    const withFault = ${options.failOpeningCheckpoint === true};
    const fixtureModule = (source) => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });
    registerHooks({
      resolve(specifier, context, next) {
        if (!context.parentURL?.endsWith('/roomService.ts')) return next(specifier, context);
        if (specifier === './kpTurnService.js') return fixtureModule(${JSON.stringify(service)});
        if (withFault && specifier === './roomMemory.js') {
          return fixtureModule("export async function extractMemoryPoints() { return ['The archive is silent']; }");
        }
        if (withFault && specifier === './roomStorage.js') {
          const real = JSON.stringify(next(specifier, context).url);
          return fixtureModule(
            'export * from ' + real + '; import { updateRoomStateSnapshot as write } from ' + real + ';' +
            'let failed = false;' +
            'export async function updateRoomStateSnapshot(roomId, state, phase) {' +
            '  if (!failed && JSON.parse(state).messages?.some(m => m.content === "The archive is quiet.")) {' +
            '    failed = true; process.stdout.write("keeper fixture rejected the opening checkpoint" + String.fromCharCode(10));' +
            '    throw new Error("opening checkpoint unavailable");' +
            '  } return write(roomId, state, phase);' +
            '}'
          );
        }
        return next(specifier, context);
      }
    });
  `)
}

async function journey(backend: 'local' | 'postgres'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aikp-room-journey-'))
  const fixtureRoot = join(root, 'prepared')
  const localDossiers = join(root, 'local-dossiers')
  const dataDir = join(root, 'sqlite')
  const jwtSecret = randomBytes(32).toString('hex')
  const children: ChildProcess[] = []
  const sockets: WebSocket[] = []
  const pausedKeepers = new WeakSet<ChildProcess>()
  const rejectedOpenings = new WeakSet<ChildProcess>()
  const shared = backend === 'postgres'
  let base: string
  async function launch(keeper?: KeeperFixture): Promise<ChildProcess> {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    const args = ['--import', 'tsx']
    if (keeper) args.push('--import', keeperFixture(keeper))
    args.push('src/app.ts')
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        TEST_SHARED_ROOMS_DATABASE_URL: undefined,
        DEPLOYMENT_MODE: shared ? 'shared-accounts' : 'local',
        ENABLE_SHARED_ROOMS: shared ? '1' : undefined,
        SHARED_ROOM_FIXTURE_DIR: fixtureRoot,
        DATABASE_URL: shared ? databaseUrl : undefined,
        DATA_DIR: dataDir,
        DOSSIER_DATA_DIR: localDossiers,
        RAG_DATA_DIR: join(root, 'local-rag'),
        UPLOADS_DIR: join(root, 'uploads'),
        JWT_SECRET: jwtSecret,
        MOCK_AI: '1',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    if (keeper?.pauseAfterTool || keeper?.failOpeningCheckpoint) {
      let output = ''
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString()
        if (output.includes('keeper fixture paused after HP tool')) pausedKeepers.add(child)
        if (output.includes('keeper fixture rejected the opening checkpoint')) rejectedOpenings.add(child)
      })
    } else child.stdout?.resume()
    child.stderr?.resume()
    return child
  }
  async function ready(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && child.exitCode === null) {
      const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
      if (response?.ok) return
      await delay(50)
    }
    throw new Error(`${backend} gameplay process did not become ready (exit ${child.exitCode})`)
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
  async function connect(token: string) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws?token=' + encodeURIComponent(token))
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
      frames,
      async waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
        const existing = frames.find(predicate)
        if (existing) return existing
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error(`Missing protocol frame for ${backend}: ${JSON.stringify(frames.map((frame) => [frame.type, frame.eventType]))}`))
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

  try {
    let first = await launch()
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
      first = await launch()
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
    hostSocket.send(chat(roomId, pendingAction))
    await ownerSocket.waitFor((frame) => frame.payload?.message?.content === pendingAction)
    if (!shared) {
      await expect.poll(async () => (await detail(roomId, host.token)).state.pendingTurnMessages, { timeout: 24_000 }).toMatchObject([
        { authorUserId: host.user.id, characterId: hostCard.id, content: pendingAction },
      ])
    }

    // Kill the whole gameplay process while the action is pending so that
    // transport cleanup cannot masquerade as the host leaving the room.
    await stop(first)
    const restarted = await launch()
    await ready(restarted)
    const persisted = await detail(roomId, host.token)
    expect(persisted).toMatchObject({
      roomId, ownerId: host.user.id, storyId, phase: 'playing',
      state: { workflow: 'dossier', turnWindowMs: 60_000, pendingTurnMessages: [{ authorUserId: host.user.id, characterId: hostCard.id, content: pendingAction }] },
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
    if (shared) {
      await stop(restarted)
      const interrupted = await launch({ pauseAfterTool: true })
      await ready(interrupted)
      const live = await connect(originalOwner.token)
      live.send({ type: 'room:join', roomId: solo.roomId })
      await live.waitFor((frame) => frame.type === 'room:state')
      const damageAction = 'Recover the damaged ledger'
      live.send(chat(solo.roomId, damageAction))
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
    }
  } finally {
    await Promise.all(children.map(stop))
    sockets.forEach((socket) => socket.terminate())
    await rm(root, { recursive: true, force: true })
  }
}

describe('room protocol across a gameplay process restart', () => {
  it('creates and resumes solo and multiplayer investigations in SQLite', () => journey('local'), 60_000)
  it.skipIf(!databaseUrl)('runs the same solo and multiplayer investigations in PostgreSQL', () => journey('postgres'), 60_000)
})
