import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertPathInDir } from './pathSafety.js'
import { isInternalUuidFileName } from './fileNames.js'

export interface JsonArtifactSearchOptions {
  /** Required filename suffix, for example `.json` or `.gaps.json`. */
  suffix?: string
  /** Suffixes to exclude when the required suffix is broad (`.json`). */
  excludeSuffixes?: readonly string[]
}

/** Create a new server-owned JSON artifact path without using external ids. */
export function createJsonArtifactPath(rootDir: string, suffix = '.json'): string {
  return assertPathInDir(rootDir, path.join(rootDir, `${randomUUID()}${suffix}`), 'artifact path')
}

/** Readers continue to see a complete old artifact until the rename commits. */
export function replaceJsonArtifactSync(file: string, json: string): void {
  const partial = createJsonArtifactPath(path.dirname(file), '.tmp')
  try {
    fs.writeFileSync(partial, json, { encoding: 'utf-8', flag: 'wx' })
    fs.renameSync(partial, file)
  } catch (error) {
    try { fs.unlinkSync(partial) } catch { /* best effort */ }
    throw error
  }
}

export async function replaceJsonArtifact(file: string, json: string): Promise<void> {
  const partial = createJsonArtifactPath(path.dirname(file), '.tmp')
  try {
    await fsp.writeFile(partial, json, { encoding: 'utf-8', flag: 'wx' })
    await fsp.rename(partial, file)
  } catch (error) {
    await fsp.unlink(partial).catch(() => undefined)
    throw error
  }
}

/**
 * Find persisted JSON artifacts by their stored external id.
 * The id is read from file contents; it is never interpolated into a path.
 */
export function findJsonArtifactPaths(
  rootDir: string,
  externalId: string,
  options: JsonArtifactSearchOptions = {},
): string[] {
  const matches: string[] = []
  for (const filePath of listJsonArtifactPaths(rootDir, options)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { scriptId?: unknown }
      if (parsed && parsed.scriptId === externalId) matches.push(filePath)
    } catch {
      // Corrupt/unrelated files are ignored by callers' existing scan semantics.
    }
  }
  return matches
}

/** Enumerate matching names without reading files or following paths outside the owner directory. */
export function* listJsonArtifactPaths(rootDir: string, options: JsonArtifactSearchOptions): IterableIterator<string> {
  if (!fs.existsSync(rootDir)) return
  const suffix = options.suffix ?? '.json'
  const excluded = options.excludeSuffixes ?? []
  for (const fileName of fs.readdirSync(rootDir)) {
    if (!fileName.endsWith(suffix) || excluded.some((item) => fileName.endsWith(item))) continue
    yield assertPathInDir(rootDir, path.join(rootDir, fileName), 'artifact path')
  }
}

/** Whether a persisted artifact path uses the server-owned UUID filename form. */
export function isInternalJsonArtifactPath(filePath: string): boolean {
  return isInternalUuidFileName(path.basename(filePath))
}
