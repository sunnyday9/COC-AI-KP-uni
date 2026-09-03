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
 */
import path from 'node:path'
import { assertSafeId } from './pathSafety.js'
import { BadRequestError } from './errors.js'

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
