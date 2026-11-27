import fs from 'node:fs'
import path from 'node:path'
import { DOSSIER_DATA_DIR, RAG_DATA_DIR, SHARED_ROOMS_ENABLED, SHARED_ROOM_FIXTURE_DIR } from '../config.js'
import { getDb } from '../db/index.js'
import { findJsonArtifactPaths, isInternalJsonArtifactPath } from '../utils/jsonArtifact.js'
import { assertPathInDir } from '../utils/pathSafety.js'

export type ArtifactKind = 'index' | 'dossier' | 'gaps' | 'annex'

const suffixes = { index: '.json', dossier: '.json', gaps: '.gaps.json', annex: '.annex.json' }
const dossierSidecars = [suffixes.gaps, suffixes.annex]

export function storyArtifactDirectory(kind: ArtifactKind, userId: number): string {
  if (SHARED_ROOMS_ENABLED) {
    const root = SHARED_ROOM_FIXTURE_DIR!
    const directory = kind === 'index'
      ? path.join(root, 'rag', String(userId), 'rag_index')
      : path.join(root, 'dossiers', String(userId))
    return assertPathInDir(root, directory, 'shared room fixture')
  }
  return kind === 'index'
    ? path.join(RAG_DATA_DIR, String(userId), 'rag_index')
    : path.join(DOSSIER_DATA_DIR, String(userId))
}

/** Look up an existing registered file without scanning the artifact directory. */
export function findRegisteredStoryArtifact(kind: ArtifactKind, userId: number, storyId: string): string | undefined {
  if (SHARED_ROOMS_ENABLED) return undefined
  const db = getDb()
  const row = db.prepare(
    'SELECT file_name FROM story_artifact_locations WHERE user_id = ? AND story_id = ? AND kind = ?',
  ).get(userId, storyId, kind) as { file_name: string } | undefined
  if (!row) return undefined
  const dir = storyArtifactDirectory(kind, userId)
  const file = assertPathInDir(dir, path.join(dir, row.file_name), 'story artifact')
  return fs.existsSync(file) ? file : undefined
}

/** Indexed positive lookups. Preexisting folders migrate as their artifacts are read. */
export function findStoryArtifacts(kind: ArtifactKind, userId: number, storyId: string): string[] {
  const registered = findRegisteredStoryArtifact(kind, userId, storyId)
  if (registered) return [registered]

  const files = scanStoryArtifacts(kind, storyArtifactDirectory(kind, userId), storyId)
  if (!SHARED_ROOMS_ENABLED && files.length === 1 && isInternalJsonArtifactPath(files[0]!)) {
    rememberStoryArtifact(kind, userId, storyId, files[0]!)
  }
  return files
}

/** Search a single owner directory by external ID without registering files. */
function scanStoryArtifacts(kind: ArtifactKind, directory: string, storyId: string): string[] {
  return findJsonArtifactPaths(directory, storyId, storyArtifactSearchOptions(kind))
}

export function storyArtifactSearchOptions(kind: ArtifactKind) {
  return {
    suffix: suffixes[kind],
    excludeSuffixes: kind === 'dossier' ? dossierSidecars : undefined,
  }
}

/** Publish a server-generated filename after the complete blob has been committed. */
export function rememberStoryArtifact(kind: ArtifactKind, userId: number, storyId: string, file: string): void {
  const name = path.basename(file)
  if (!isInternalJsonArtifactPath(name) || !name.endsWith(suffixes[kind])) {
    throw new Error('Expected a server-owned story artifact filename')
  }
  getDb().prepare(`
    INSERT INTO story_artifact_locations (user_id, story_id, kind, file_name) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, story_id, kind) DO UPDATE SET file_name = excluded.file_name
  `).run(userId, storyId, kind, name)
}

export function forgetStoryArtifact(kind: ArtifactKind, userId: number, storyId: string): void {
  getDb().prepare(
    'DELETE FROM story_artifact_locations WHERE user_id = ? AND story_id = ? AND kind = ?',
  ).run(userId, storyId, kind)
}
