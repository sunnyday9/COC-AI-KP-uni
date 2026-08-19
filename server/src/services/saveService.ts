/**
 * Save service (api-contract §7) — migrated from
 * original/ai-trpg-web/electron/ipc/saveHandlers.cjs (save:list / save:read /
 * save:write) with two adaptations:
 *  - DB-backed: the Task 1 `saves` table (user_id, save_id, data JSON,
 *    updated_at) replaces the original userData/saves/*.json files.
 *  - save:delete did not exist in the original (saveHandlers.cjs has no
 *    delete handler); DELETE /api/saves/:id is added per api-contract §7.
 *
 * GET /api/saves/:id returns the full GameSaveSnapshot JSON document — the
 * original client's readSaveMeta simply called readSave and picked fields
 * (saveService.ts:64-77), so no metadata endpoint is needed (contract-first).
 *
 * Validation (task-5-brief): the snapshot must be a JSON object carrying a
 * numeric `version` field (GameSaveSnapshot.version).
 */
import { getDb } from '../db/index.js'
import { BadRequestError, NotFoundError } from '../utils/errors.js'
import { assertId } from '../utils/fileNames.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** save:list — saveIds, most recently written first. */
export function listSaves(userId: number): string[] {
  const rows = getDb()
    .prepare('SELECT save_id FROM saves WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as { save_id: string }[]
  return rows.map((r) => r.save_id)
}

/** save:read — full snapshot document. */
export function readSave(userId: number, saveId: string): unknown {
  assertId(saveId, 'saveId')
  const row = getDb()
    .prepare('SELECT data FROM saves WHERE user_id = ? AND save_id = ?')
    .get(userId, saveId) as { data: string } | undefined
  if (!row) throw new NotFoundError('save not found')
  try {
    return JSON.parse(row.data)
  } catch {
    // Corrupted row (should not happen via writeSave) → 400, not a 500.
    throw new BadRequestError('save data corrupted')
  }
}

/** save:write — upsert the snapshot document. */
export function writeSave(userId: number, saveId: string, data: unknown): void {
  assertId(saveId, 'saveId')
  if (!isRecord(data) || typeof data.version !== 'number') {
    throw new BadRequestError('save data must be an object with a numeric version')
  }
  getDb()
    .prepare(
      'INSERT INTO saves (user_id, save_id, data, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, save_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    )
    .run(userId, saveId, JSON.stringify(data), Date.now())
}

/** DELETE /api/saves/:id — new endpoint (api-contract §7; no original handler). */
export function deleteSave(userId: number, saveId: string): void {
  assertId(saveId, 'saveId')
  const result = getDb()
    .prepare('DELETE FROM saves WHERE user_id = ? AND save_id = ?')
    .run(userId, saveId)
  if (Number(result.changes) === 0) throw new NotFoundError('save not found')
}
