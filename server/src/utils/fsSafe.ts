/**
 * Small fs helpers that map ENOENT to the unified 404 error (the original IPC
 * handlers rejected with raw ENOENT; REST surfaces it as 404 NotFoundError).
 */
import fs from 'node:fs/promises'
import { NotFoundError } from './errors.js'

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

/** readFile that throws NotFoundError(label not found) instead of ENOENT. */
export async function readFileOr404(filePath: string, label: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath)
  } catch (err) {
    if (isEnoent(err)) throw new NotFoundError(`${label} not found`)
    throw err
  }
}

/** unlink that throws NotFoundError(label not found) instead of ENOENT. */
export async function unlinkOr404(filePath: string, label: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if (isEnoent(err)) throw new NotFoundError(`${label} not found`)
    throw err
  }
}
