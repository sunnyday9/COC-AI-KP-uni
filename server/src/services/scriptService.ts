/**
 * Script library service (api-contract §6) — migrated from
 * original/ai-trpg-web/electron/ipc/fileHandlers.cjs (file:saveScriptToLibrary,
 * file:readScript, file:saveScript, file:deleteScript).
 *
 * Storage model (2026-08-20 DB 映射重构，门禁合规)：
 *  - scripts 表（DB）持有 { user_id, script_id, name, content, updated_at }；
 *  - **saveScript 纯 DB**（content 列，不触达 fs）；
 *  - readScript 仅 DB 读 content；
 *  - deleteScript 删 DB + 按内部 file_path 删文件（外部 id 不进入 fs 路径）。
 *
 * file:listScripts / file:importScript（含落盘与存量文件系统自动导入）已于
 * 2026-09-13 退役（#91 C 桶「全链退役」拍板，#94）——对应路由与客户端 bridge
 * 包装全仓零消费方。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { UPLOADS_DIR } from '../config.js'
import { getDb } from '../db/index.js'
import { BadRequestError, NotFoundError } from '../utils/errors.js'
import { assertId, sanitizeFilename } from '../utils/fileNames.js'
import { unlinkOr404 } from '../utils/fsSafe.js'
import { assertPathInDir, resolveFileInDir } from '../utils/pathSafety.js'

function scriptsDir(userId: number): string {
  return path.join(UPLOADS_DIR, String(userId), 'scripts')
}

async function ensureScriptsDir(userId: number): Promise<string> {
  const dir = scriptsDir(userId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

interface ScriptRow {
  script_id: string
  name: string
  content: string
  file_path: string
}

/** DB 查询：外部 script_id → DB 记录（content 优先；file_path 为内部文件名）。 */
function queryScriptRow(userId: number, scriptId: string): ScriptRow | null {
  const row = getDb()
    .prepare(`SELECT script_id, name, content, file_path FROM scripts WHERE user_id = ? AND script_id = ?`)
    .get(userId, scriptId) as ScriptRow | undefined
  return row ?? null
}

/** file:readScript — 仅 DB 查询（外部 id 不进入 fs 路径）。 */
export async function readScript(userId: number, id: string): Promise<{ name: string; content: string }> {
  assertId(id, 'script id')
  const existing = queryScriptRow(userId, id)
  if (existing) {
    return { name: existing.name, content: existing.content }
  }
  throw new NotFoundError('script not found')
}

/**
 * file:saveScript / file:saveScriptToLibrary — upsert utf-8 content.
 * 纯 DB 存储（scripts.content 列），不触达文件系统 → 外部输入不进入 fs 路径。
 */
export async function saveScript(userId: number, id: string, content: string): Promise<void> {
  if (typeof content !== 'string') throw new BadRequestError('content must be a string')
  const safeId = sanitizeFilename(id, 'script.json')
  const db = getDb()
  db.prepare(`INSERT INTO scripts (user_id, script_id, name, content, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, script_id) DO UPDATE SET name = excluded.name, content = excluded.content, updated_at = excluded.updated_at`)
    .run(userId, safeId, safeId, content, Date.now())
}

/** file:deleteScript — 删 DB 记录 + 按内部 file_path 删文件（外部 id 不进入 fs 路径）。 */
export async function deleteScript(userId: number, id: string): Promise<void> {
  assertId(id, 'script id')
  const db = getDb()
  const existing = queryScriptRow(userId, id)
  if (!existing) {
    throw new NotFoundError('script not found')
  }
  if (existing.file_path) {
    const dir = await ensureScriptsDir(userId)
    const safePath = assertPathInDir(dir, resolveFileInDir(dir, existing.file_path, 'script file'), 'script file (sink)')
    await unlinkOr404(safePath, 'script')
  }
  db.prepare(`DELETE FROM scripts WHERE user_id = ? AND script_id = ?`).run(userId, id)
}
