/**
 * Script library service (api-contract §6) — migrated from
 * original/ai-trpg-web/electron/ipc/fileHandlers.cjs (file:listScripts,
 * file:saveScriptToLibrary, file:readScript, file:saveScript,
 * file:deleteScript, file:importScript).
 *
 * Storage: `UPLOADS_DIR/<userId>/scripts/<id>` — the original kept the
 * scripts library in the project root `scripts/` dir as .json/.md files; the
 * server version adds the user dimension (task-5-brief decision 2) and
 * replaces paths with ids. PUT /api/scripts/:id is an upsert covering both
 * file:saveScript (update) and file:saveScriptToLibrary (create from a
 * generated filename); both sanitized the filename server-side before writing,
 * so PUT sanitizes the id the same way (idempotent for already-sanitized ids).
 *
 * importScript validates .json payloads (`meta` + `scenes` required, mirroring
 * the original 'Invalid script format' check) and accepts .md uploads as-is
 * (the library lists .json + .md files; the original dialog only offered
 * .json — accepting .md is a strict superset of the original surface).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { UPLOADS_DIR } from '../config.js'
import { BadRequestError } from '../utils/errors.js'
import { assertId, sanitizeFilename } from '../utils/fileNames.js'
import { readFileOr404, unlinkOr404 } from '../utils/fsSafe.js'
import { assertParentRealPathInDir, assertRealPathInDir, resolveFileInDir } from '../utils/pathSafety.js'

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

function resolveScriptFile(userId: number, id: string): string {
  return resolveFileInDir(scriptsDir(userId), id, 'script file')
}

/** Resolve and re-assert containment right at the fs sink (defense in depth).
 * Realpath-based: symlink escapes are blocked, not just `../` sequences. */
async function assertScriptSinkPath(userId: number, safePath: string): Promise<string> {
  return assertRealPathInDir(scriptsDir(userId), safePath, 'script file (sink)')
}

/** file:listScripts — readdir filtered by .json/.md. */
export async function listScripts(userId: number): Promise<ScriptListItem[]> {
  const dir = await ensureScriptsDir(userId)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.md')))
    .map((e) => ({ name: e.name, id: e.name }))
}

/** file:readScript — raw utf-8 content. */
export async function readScript(userId: number, id: string): Promise<{ name: string; content: string }> {
  assertId(id, 'script id')
  const safePath = await assertScriptSinkPath(userId, resolveScriptFile(userId, id))
  const dataBuffer = await readFileOr404(safePath, 'script')
  return { name: id, content: dataBuffer.toString('utf-8') }
}

/**
 * file:saveScript / file:saveScriptToLibrary — upsert utf-8 content at the
 * sanitized id. The sanitizer mirrors saveScriptToLibrary's server-side
 * filename cleanup; assertSafeId rejects anything still unsafe.
 */
export async function saveScript(userId: number, id: string, content: string): Promise<void> {
  if (typeof content !== 'string') throw new BadRequestError('content must be a string')
  const safeId = sanitizeFilename(id, 'script.json')
  const dir = await ensureScriptsDir(userId)
  await fs.writeFile(await assertParentRealPathInDir(dir, path.join(dir, safeId), 'script file (sink)'), content, 'utf-8')
}

/**
 * file:importScript — persist the uploaded bytes; .json payloads must parse
 * and carry `meta` + `scenes` (mirrors the original 'Invalid script format').
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
  const dir = await ensureScriptsDir(userId)
  await fs.writeFile(await assertParentRealPathInDir(dir, path.join(dir, id), 'script file (sink)'), file.buffer)
  return { ok: true, name: id, id }
}

/** file:deleteScript — unlink by id. */
export async function deleteScript(userId: number, id: string): Promise<void> {
  assertId(id, 'script id')
  const safePath = await assertScriptSinkPath(userId, resolveScriptFile(userId, id))
  await unlinkOr404(safePath, 'script')
}
