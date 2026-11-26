import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getPostgresPool, inPostgresTransaction, postgresError } from '../db/postgres.js'
import { CapacityError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'
import { claimNextRoomCommand, type ClaimedRoomCommand } from './roomStorage.js'

const deadlineMs = 2_500
const roomLimit = 32
const globalLimit = 512
const commandBytes = 128 * 1024
const pollMs = 50
let activeGatewayCalls = 0

export class RoomRelayUnavailable extends CapacityError {
  constructor() {
    super('Room worker unavailable. Retry the room operation.')
  }
}

export async function initializeRoomMailbox(): Promise<void> {
  try {
    await inPostgresTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(17407, 121)')
      await client.query(
        'CREATE TABLE IF NOT EXISTS room_commands (' +
        ' sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,' +
        ' request_id UUID UNIQUE NOT NULL, room_id TEXT NOT NULL, user_id BIGINT NOT NULL,' +
        ' command JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,' +
        ' claimed_by UUID, result JSONB);' +
        'ALTER TABLE room_commands ADD COLUMN IF NOT EXISTS presence_loss BOOLEAN NOT NULL DEFAULT false;' +
        'ALTER TABLE room_commands ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;' +
        'CREATE UNIQUE INDEX IF NOT EXISTS room_commands_presence_loss ON room_commands (room_id, user_id) WHERE presence_loss;' +
        'CREATE INDEX IF NOT EXISTS room_commands_by_room ON room_commands (room_id, sequence);' +
        'CREATE INDEX IF NOT EXISTS room_commands_expiry ON room_commands (expires_at)',
      )
    })
  } catch (error) {
    throw postgresError(error)
  }
}

type CommandResult = { ok: true; value: unknown } | { ok: false }

/** Include membership lookup and admission in the same transport deadline. */
export async function withRoomRelayDeadline<T>(
  caller: AbortSignal | undefined, run: (signal: AbortSignal, expiresAt: number) => Promise<T>,
): Promise<T> {
  const expiresAt = Date.now() + deadlineMs
  const timeout = AbortSignal.timeout(deadlineMs)
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout
  if (signal.aborted || activeGatewayCalls >= 128) throw new RoomRelayUnavailable()
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new RoomRelayUnavailable())
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    activeGatewayCalls++
    const operation = Promise.resolve().then(() => run(signal, expiresAt))
      .finally(() => { activeGatewayCalls-- })
    return await Promise.race([operation, cancelled])
  } catch {
    throw new RoomRelayUnavailable()
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function sendRoomCommand(
  roomId: string, userId: number, command: unknown, pending: AbortSignal, expiresAt: number,
): Promise<unknown> {
  const raw = JSON.stringify(command)
  if (pending.aborted || Buffer.byteLength(raw) > commandBytes) throw new RoomRelayUnavailable()
  const requestId = randomUUID()
  const pool = getPostgresPool()
  // Assigning a request ID before admission lets cancellation cover an INSERT
  // which was still waiting for a pool client when the transport closed.
  const admitted = inPostgresTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = '500ms'")
    await client.query('SELECT pg_advisory_xact_lock(17407, 121)')
    if (pending.aborted) return false
    await client.query(
      'DELETE FROM room_commands WHERE sequence IN (SELECT sequence FROM room_commands' +
      ' WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 32)',
    )
    const capacity = await client.query<{ total: number; room: number }>(
      'SELECT count(*)::int AS total, count(*) FILTER (WHERE room_id = $1)::int AS room' +
      ' FROM room_commands WHERE NOT presence_loss AND expires_at > clock_timestamp()', [roomId],
    )
    if (capacity.rows[0].total >= globalLimit || capacity.rows[0].room >= roomLimit || pending.aborted) return false
    await client.query(
      'INSERT INTO room_commands (request_id, room_id, user_id, command, expires_at)' +
      " VALUES ($1, $2, $3, $4, clock_timestamp() + $5 * interval '1 millisecond')",
      [requestId, roomId, userId, raw, Math.max(0, expiresAt - Date.now())],
    )
    return true
  })
  const waitForResult = async (): Promise<unknown> => {
    if (!await admitted) throw new RoomRelayUnavailable()
    while (!pending.aborted) {
      const result = await pool.query<{ result: CommandResult | null }>(
        'SELECT result FROM room_commands WHERE request_id = $1 AND expires_at > clock_timestamp()', [requestId],
      )
      const row = result.rows[0]
      if (!row || row.result?.ok === false || pending.aborted) throw new RoomRelayUnavailable()
      if (row.result?.ok) return row.result.value
      await delay(pollMs, undefined, { signal: pending })
    }
    throw new RoomRelayUnavailable()
  }
  try {
    return await waitForResult()
  } finally {
    // A deleted command cannot be started. If already executing, the actor may
    // still commit: callers retry chat with the original durable action ID.
    void admitted.then(async (inserted) => {
      if (inserted) await pool.query('DELETE FROM room_commands WHERE request_id = $1', [requestId])
    })
      .catch((error) => logger.warn(postgresError(error).message))
  }
}

async function executeClaim(
  workerId: string, row: ClaimedRoomCommand, execute: (roomId: string, userId: number, command: unknown) => Promise<unknown>,
): Promise<void> {
  const pool = getPostgresPool()
  const live = await pool.query(
    'SELECT 1 FROM room_commands WHERE request_id = $1 AND claimed_by = $2 AND expires_at > clock_timestamp()',
    [row.request_id, workerId],
  )
  if (!live.rowCount) return
  let result: CommandResult
  try {
    result = { ok: true, value: await execute(row.room_id, row.user_id, row.command) }
  } catch (error) {
    logger.warn('Relayed room command failed', { error: postgresError(error).message })
    if (row.presence_loss) return // A worker can reclaim the durable intent.
    result = { ok: false }
  }
  if (row.presence_loss) {
    await pool.query('DELETE FROM room_commands WHERE request_id = $1 AND claimed_by = $2', [row.request_id, workerId])
    return
  }
  await pool.query(
    'UPDATE room_commands SET result = $3 WHERE request_id = $1 AND claimed_by = $2 AND expires_at > clock_timestamp()',
    [row.request_id, workerId, JSON.stringify(result)],
  )
}

export async function runRoomMailbox(
  workerId: string, execute: (roomId: string, userId: number, command: unknown) => Promise<unknown>,
): Promise<void> {
  const active = new Set<string>()
  let cleanAfter = 0
  for (;;) {
    try {
      if (Date.now() >= cleanAfter) {
        await getPostgresPool().query(
          'DELETE FROM room_commands WHERE sequence IN (SELECT sequence FROM room_commands' +
          ' WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 512)',
        )
        cleanAfter = Date.now() + deadlineMs
      }
      const row = active.size < 8 && await claimNextRoomCommand(workerId, active)
      if (row) {
        active.add(row.request_id)
        void executeClaim(workerId, row, execute)
          .catch((error) => logger.warn(postgresError(error).message))
          .finally(() => active.delete(row.request_id))
        continue
      }
    } catch (error) {
      logger.warn(postgresError(error).message)
    }
    await delay(pollMs)
  }
}
