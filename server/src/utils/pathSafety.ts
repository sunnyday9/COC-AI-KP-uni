/**
 * Path traversal protection — migrated from
 * original/ai-trpg-web/electron/ipc/pathSafety.cjs (logic unchanged, CJS → ESM TS).
 * Any path built from user input MUST pass through these helpers first
 * (see docs/api-contract.md §10).
 */
import fs from 'node:fs/promises'
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

export function assertPathInDir(rootDir: string, candidatePath: string, label = 'path'): string {
  if (!isNonEmptyString(candidatePath)) throw new Error(`${label} must be a non-empty string`)
  const root = path.resolve(rootDir)
  const cand = path.resolve(candidatePath)
  if (!isSubpath(root, cand)) throw new Error(`${label} is outside the allowed directory`)
  return cand
}

export function resolveFileInDir(rootDir: string, fileName: string, label = 'file'): string {
  if (!isNonEmptyString(fileName)) throw new Error(`${label} must be a non-empty string`)
  const full = path.resolve(rootDir, fileName)
  return assertPathInDir(rootDir, full, label)
}

export async function assertRealPathInDir(rootDir: string, candidatePath: string, label = 'path'): Promise<string> {
  const cand = assertPathInDir(rootDir, candidatePath, label)
  try {
    const real = await fs.realpath(cand)
    assertPathInDir(rootDir, real, `${label} (realpath)`)
  } catch {
    // If the path doesn't exist yet (e.g. before write) or realpath fails, fall back to string check.
  }
  return cand
}

export async function assertParentRealPathInDir(rootDir: string, candidatePath: string, label = 'path'): Promise<string> {
  const cand = assertPathInDir(rootDir, candidatePath, label)
  const parent = path.dirname(cand)
  try {
    const realParent = await fs.realpath(parent)
    assertPathInDir(rootDir, realParent, `${label} directory (realpath)`)
  } catch {
    // Parent may not exist yet; creation will still be constrained by the resolved path check above.
  }
  return cand
}
