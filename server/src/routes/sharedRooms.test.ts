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
  actionId?: string
  status?: string
  messageId?: string
  code?: string
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
  endingOpeningBarrier?: string
}

function keeperFixture(options: KeeperFixture): string {
  const service = `
    import { existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const endingOpeningBarrier = ${JSON.stringify(options.endingOpeningBarrier)};
    let turns = 0;
    export async function runKpTurn(_userId, { messages }, turn) {
      if (endingOpeningBarrier && ++turns === 1) {
        process.stdout.write('keeper fixture holding the only turn slot' + String.fromCharCode(10));
        while (!existsSync(endingOpeningBarrier)) await delay(20);
      } else if (endingOpeningBarrier && turns === 2) {
        turn.mutatorFactory(turn.activeCharacterId).endGame({
          outcome: 'closed', title: 'Archive closed', summary: 'The archive closes at the opening.',
        });
      }
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
  const heldOpeningSlots = new WeakSet<ChildProcess>()
  const pausedAcceptances = new WeakSet<ChildProcess>()
  const shared = backend === 'postgres'
  let base: string
  async function launch(options: KeeperFixture & { pauseActionId?: string } = {}): Promise<ChildProcess> {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    const args = ['--import', 'tsx']
    if (options.pauseAfterTool !== undefined || options.failOpeningCheckpoint || options.endingOpeningBarrier) {
      args.push('--import', keeperFixture(options))
    }
    if (options.pauseActionId) args.push('--import', pauseAcceptance(options.pauseActionId))
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
        KP_ACTIVE_TURNS: options.endingOpeningBarrier ? '1' : undefined,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    if (options.pauseAfterTool || options.pauseActionId || options.failOpeningCheckpoint || options.endingOpeningBarrier) {
      let output = ''
      child.stdout?.on('data', (data: Buffer) => {
        output = (output + data.toString()).slice(-4_096)
        if (output.includes('keeper fixture paused after HP tool')) pausedKeepers.add(child)
        if (output.includes('keeper fixture rejected the opening checkpoint')) rejectedOpenings.add(child)
        if (output.includes('keeper fixture holding the only turn slot')) heldOpeningSlots.add(child)
        if (output.includes('chat fixture paused before commit')) pausedAcceptances.add(child)
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
})
