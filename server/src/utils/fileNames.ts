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
