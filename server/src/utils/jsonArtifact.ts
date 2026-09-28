import fs from 'node:fs'
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

/**
 * Find persisted JSON artifacts by their stored external id.
 * The id is read from file contents; it is never interpolated into a path.
 */
export function findJsonArtifactPaths(
  rootDir: string,
  externalId: string,
  options: JsonArtifactSearchOptions = {},
): string[] {
  if (!fs.existsSync(rootDir)) return []

  const suffix = options.suffix ?? '.json'
  const excluded = options.excludeSuffixes ?? []
  const matches: string[] = []
  for (const fileName of fs.readdirSync(rootDir)) {
    if (!fileName.endsWith(suffix) || excluded.some((item) => fileName.endsWith(item))) continue

    // Validate the real path before reading. A symlinked artifact must not
    // turn a content lookup into an outside-root read.
    const filePath = assertPathInDir(rootDir, path.join(rootDir, fileName), 'artifact path')
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { scriptId?: unknown }
      if (parsed && parsed.scriptId === externalId) matches.push(filePath)
    } catch {
      // Corrupt/unrelated files are ignored by callers' existing scan semantics.
    }
  }
  return matches
}

/** Whether a persisted artifact path uses the server-owned UUID filename form. */
export function isInternalJsonArtifactPath(filePath: string): boolean {
  return isInternalUuidFileName(path.basename(filePath))
}
