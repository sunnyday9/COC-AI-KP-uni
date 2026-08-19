/**
 * Script library service (api-contract §6) — migrated from
 * original/ai-trpg-web/electron/ipc/fileHandlers.cjs (file:listScripts,
 * file:saveScriptToLibrary, file:readScript, file:saveScript,
 * file:deleteScript, file:importScript).
 *
 * Storage model (2026-08-20 DB 映射重构，门禁合规)：
 *  - scripts 表（DB）持有 { user_id, script_id, name, content, updated_at }；
 *  - **saveScript 纯 DB**（content 列，不触达 fs）；
 *  - importScript 落盘（内部 uuid 文件名）+ DB（content = 文件内容）；
 *  - readScript 先 DB 读 content，未命中再查文件系统存量（旧版 id=文件名）；
 *  - deleteScript 删 DB + 按内部 file_path 删文件（外部 id 不进入 fs 路径）。
 *
 * importScript validates .json payloads (`meta` + `scenes` required, mirroring
 * the original 'Invalid script format' check) and accepts .md uploads as-is.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { UPLOADS_DIR } from '../config.js'
import { getDb } from '../db/index.js'
import { BadRequestError, NotFoundError } from '../utils/errors.js'
import { assertId, sanitizeFilename } from '../utils/fileNames.js'
import { readFileOr404, unlinkOr404 } from '../utils/fsSafe.js'
import { assertPathInDir, resolveFileInDir } from '../utils/pathSafety.js'

/** Script library extensions — mirrors listScripts' .json/.md filter. */
export const SCRIPT_EXTENSIONS = ['.json', '.md']

export interface ScriptListItem {
  name: string
  id: string
}

export interface UploadedFile {
  originalname: string
  buffer: Buffer
  size: number
}

function scriptsDir(userId: number): string {
  return path.join(UPLOADS_DIR, String(userId), 'scripts')
}

async function ensureScriptsDir(userId: number): Promise<string> {
  const dir = scriptsDir(userId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 生成内部文件名：uuid + 原扩展名（非外部输入，fs 路径唯一来源）。 */
function generateFilePath(displayName: string): string {
  const ext = path.extname(displayName).toLowerCase()
  return `${crypto.randomUUID()}${ext || '.json'}`
}

/** 校验 file_path 只含安全字符且带扩展名（DB 内部值，防御性校验）。 */
function assertStoredFilePath(filePath: string): string {
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9]+)?$/.test(filePath)) {
    throw new NotFoundError('script file missing')
  }
  return filePath
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

function isScriptFile(name: string): boolean {
  const lower = name.toLowerCase()
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** 存量文件系统数据自动导入 DB（旧版 id=文件名 存储，首次访问时迁移）。
 * 跳过内部 uuid 文件名（file_path 风格，非对外 id）。 */
async function importLegacyFile(userId: number, fileName: string): Promise<ScriptRow | null> {
  if (!isScriptFile(fileName)) return null
  // uuid 文件名（内部存储）不作为存量导入 —— 它们由 DB 记录引用。
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(fileName)) return null
  const dir = await ensureScriptsDir(userId)
  const legacyPath = resolveFileInDir(dir, fileName, 'script file')
  let buffer: Buffer
  try {
    buffer = await fs.readFile(legacyPath)
  } catch {
    return null
  }
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO scripts (user_id, script_id, name, content, file_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, fileName, fileName, buffer.toString('utf-8'), fileName, Date.now())
  return queryScriptRow(userId, fileName)
}

/** file:listScripts — DB 为主 + 存量文件系统兜底导入。 */
export async function listScripts(userId: number): Promise<ScriptListItem[]> {
  const dir = await ensureScriptsDir(userId)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && isScriptFile(e.name)) {
        await importLegacyFile(userId, e.name)
      }
    }
  } catch {
    // 目录不存在或不可读 → 忽略，仅返回 DB 记录
  }
  const rows = getDb()
    .prepare(`SELECT script_id, name FROM scripts WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as { script_id: string; name: string }[]
  return rows.map((r) => ({ name: r.name, id: r.script_id }))
}

/** file:readScript — 仅 DB 查询（外部 id 不进入 fs 路径）。
 * 存量文件系统数据由 listScripts 的 readdir 扫描自动导入。 */
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

/**
 * file:importScript — persist the uploaded bytes; .json payloads must parse
 * and carry `meta` + `scenes` (mirrors the original 'Invalid script format').
 * 落盘文件名 = 服务端 uuid（内部值）；DB 同时存 content。
 */
export async function importScript(
  userId: number,
  file: UploadedFile | undefined,
): Promise<{ ok: boolean; name?: string; id?: string; error?: string }> {
  if (!file || !file.buffer) return { ok: false, error: 'no file received' }
  let id: string
  try {
    id = sanitizeFilename(file.originalname, 'script.json')
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid filename' }
  }
  const ext = path.extname(id).toLowerCase()
  if (!SCRIPT_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `unsupported file type: ${ext || '(none)'}` }
  }
  if (ext === '.json') {
    try {
      const data: unknown = JSON.parse(file.buffer.toString('utf-8'))
      if (typeof data !== 'object' || data === null || !(data as { meta?: unknown }).meta || !(data as { scenes?: unknown }).scenes) {
        throw new Error('Invalid script format')
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid script format' }
    }
  }
  const filePath = generateFilePath(id)
  const dir = await ensureScriptsDir(userId)
  const target = assertPathInDir(dir, resolveFileInDir(dir, filePath, 'script file'), 'script file (sink)')
  await fs.writeFile(target, file.buffer)
  const db = getDb()
  db.prepare(`INSERT INTO scripts (user_id, script_id, name, content, file_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, id, id, file.buffer.toString('utf-8'), filePath, Date.now())
  return { ok: true, name: id, id }
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
