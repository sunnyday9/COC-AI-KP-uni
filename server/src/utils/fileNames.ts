/**
 * User-input → safe id/filename helpers (task-5-brief decision 1/2).
 *
 * Every id derived from user input (upload originalname, PUT /api/scripts/:id)
 * is normalized by `sanitizeFilename` and every id read back from a request
 * passes `assertId` (assertSafeId + BadRequestError mapping). This is the
 * security red line for path traversal — see docs/api-contract.md §10.
 *
 * Sanitizer rule set:
 *  - basename only (strip any path components, incl. Windows separators)
 *  - Windows-illegal chars `< > : " / \ | ? *` + control chars → '_'
 *    (mirrors original file:saveScriptToLibrary `/[<>:"/\\|?*]+/g` → '_')
 *  - runs of 2+ dots collapsed to one (assertSafeId rejects '..')
 *  - leading dots trimmed (no dotfiles / traversal-ish names)
 *  - trailing dots/spaces trimmed (assertSafeId rejects; mirrors original
 *    `/[. ]+$/g` trim)
 *  - Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9) get a '_'
 *    prefix (mirrors original saveScriptToLibrary guard)
 *  - empty result falls back to a default name
 *
 * The module also hosts the server-side generated/stored filename safety base
 * (D-09, consolidated from scriptService/storyService twins — issue #76):
 *  - `generateFilePath` — internal uuid filename (fs 路径唯一来源), the
 *    per-service default extension is a required parameter so each caller
 *    keeps its original behavior verbatim;
 *  - `assertStoredFilePath` — defensive whitelist re-validation of the
 *    DB-stored file_path before it is used in an fs path;
 *  - `isInternalUuidFileName` — uuid filename classifier (skip guard for
 *    legacy-store imports).
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { assertSafeId } from './pathSafety.js'
import { BadRequestError, NotFoundError } from './errors.js'

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** assertSafeId with the server's unified 400 error mapping. */
export function assertId(id: string, label = 'id'): string {
  try {
    return assertSafeId(id, label)
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err))
  }
}

/** Normalize an arbitrary user-supplied filename into a storeable id. */
export function sanitizeFilename(raw: string, fallback = 'story'): string {
  const base = path.basename(raw || '').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
  let name = base.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!name) name = fallback
  const stem = path.parse(name).name.toUpperCase()
  if (WINDOWS_RESERVED.test(stem)) name = '_' + name
  return assertId(name)
}

/**
 * Repair a filename whose UTF-8 bytes were decoded as latin1 (the classic
 * mojibake `é¾ä¸­çç¯å¡` for `雾中的灯塔`). Busboy defaults to latin1 for
 * multipart header params; when the client sent raw UTF-8 the bytes survive
 * but the string is wrong. Re-encode latin1 → original bytes → decode utf-8.
 *
 * Only applies when the result is *valid* UTF-8 with a CJK character present —
 * a genuine latin1-only filename must never be rewritten.
 */
export function repairMojibakeFilename(name: string): string {
  if (!name) return name
  try {
    const roundTripped = Buffer.from(name, 'latin1').toString('utf8')
    if (roundTripped !== name && /[\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(roundTripped)) {
      return roundTripped
    }
  } catch {
    // fall through — leave the original untouched
  }
  return name
}

/**
 * 生成内部文件名：uuid + 原扩展名（非外部输入，fs 路径唯一来源）。
 * `fallbackExt` 为调用方声明的默认扩展名（script '.json' / story '.txt'），
 * 收编自两份孪生实现时以参数表达各自原行为，语义逐字节保持（issue #76）。
 */
export function generateFilePath(displayName: string, fallbackExt: string): string {
  const ext = path.extname(displayName).toLowerCase()
  return `${crypto.randomUUID()}${ext || fallbackExt}`
}

/**
 * 校验 file_path 只含安全字符且带扩展名（DB 内部值，防御性校验）。
 * `fileKind` 进入错误消息（`${fileKind} file missing`），与收编前两份实现的
 * 消息逐字节一致（'script file missing' / 'story file missing'）。
 */
export function assertStoredFilePath(filePath: string, fileKind: string): string {
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9]+)?$/.test(filePath)) {
    throw new NotFoundError(`${fileKind} file missing`)
  }
  return filePath
}

/** uuid 文件名（内部存储）不作为存量导入 —— 它们由 DB 记录引用。 */
export function isInternalUuidFileName(fileName: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(fileName)
}
