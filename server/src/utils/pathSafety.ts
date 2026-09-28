/**
 * Path traversal protection — migrated from
 * original/ai-trpg-web/electron/ipc/pathSafety.cjs (logic unchanged, CJS → ESM TS).
 * Any path built from user input MUST pass through these helpers first
 * (see docs/api-contract.md §10).
 */
import fs from 'node:fs'
import path from 'node:path'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function assertSafeId(id: string, label = 'id'): string {
  if (!isNonEmptyString(id)) throw new Error(`${label} must be a non-empty string`)
  if (id.length > 120) throw new Error(`${label} too long`)
  // Prevent path traversal and invalid Windows filename characters.
  if (id.includes('..')) throw new Error(`${label} contains invalid sequence`)
  if (/[<>:"/\\|?*\x00-\x1F]/.test(id)) throw new Error(`${label} contains invalid characters`)
  // Windows treats trailing dots/spaces specially; reject to avoid surprises.
  if (/[. ]$/.test(id)) throw new Error(`${label} must not end with dot/space`)
  return id
}

export function isSubpath(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir)
  const cand = path.resolve(candidatePath)
  const rel = path.relative(root, cand)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Resolve the existing portion of a path and append any not-yet-created tail.
 * This keeps write checks safe while still rejecting symlinked parents that
 * resolve outside the configured root.
 */
function realpathWithMissingTail(candidatePath: string): string {
  const absolute = path.resolve(candidatePath)
  const missingTail: string[] = []
  let current = absolute

  while (true) {
    try {
      const resolved = fs.realpathSync.native(current)
      return path.join(resolved, ...missingTail.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = path.dirname(current)
      if (parent === current) return absolute
      missingTail.push(path.basename(current))
      current = parent
    }
  }
}

export function assertPathInDir(rootDir: string, candidatePath: string, label = 'path'): string {
  if (!isNonEmptyString(candidatePath)) throw new Error(`${label} must be a non-empty string`)
  const root = path.resolve(rootDir)
  const cand = path.resolve(candidatePath)
  if (!isSubpath(root, cand)) throw new Error(`${label} is outside the allowed directory`)

  try {
    const realRoot = realpathWithMissingTail(root)
    const realCandidate = realpathWithMissingTail(cand)
    if (!isSubpath(realRoot, realCandidate)) throw new Error(`${label} is outside the allowed directory`)
  } catch (err) {
    if (err instanceof Error && err.message === `${label} is outside the allowed directory`) throw err
    throw new Error(`${label} is outside the allowed directory`)
  }

  return cand
}

export function resolveFileInDir(rootDir: string, fileName: string, label = 'file'): string {
  if (!isNonEmptyString(fileName)) throw new Error(`${label} must be a non-empty string`)
  const full = path.resolve(rootDir, fileName)
  return assertPathInDir(rootDir, full, label)
}
