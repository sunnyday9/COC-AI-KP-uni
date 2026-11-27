import { statSync } from 'node:fs'
import type { IndexedStory, IndexedStoryPage } from '../../../shared/types/bridge.js'
import { getDb } from '../db/index.js'
import { storyArtifactDirectory } from '../services/storyArtifacts.js'
import { encodeStoryCursor, parseStoryPage } from '../services/storyPagination.js'
import { listIndexedStories } from './vectorStore.js'

/** Existing writers publish with atomic file replacement, which changes the directory stamp. */
function refreshIndexCatalog(userId: number): void {
  const stats = statSync(storyArtifactDirectory('index', userId), { bigint: true, throwIfNoEntry: false })
  const stamp = stats ? `${stats.dev}:${stats.ino}:${stats.mtimeNs}` : ''
  const db = getDb()
  const known = db.prepare('SELECT stamp FROM indexed_story_catalog_state WHERE user_id = ?')
    .get(userId) as { stamp: string } | undefined
  if (stamp === (known?.stamp ?? '')) return

  // Import legacy UUID and named files using the existing RAG discovery rules.
  // The checkpoint is taken before scanning so a concurrent replacement makes
  // the next request reconcile again. Normal page reads skip the file scan.
  const stories = listIndexedStories(userId)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM indexed_story_catalog WHERE user_id = ?').run(userId)
    const insert = db.prepare(`
      INSERT INTO indexed_story_catalog (user_id, story_id, name, chunk_count, indexed_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, story_id) DO UPDATE SET
        name = excluded.name, chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at
      WHERE excluded.indexed_at > indexed_story_catalog.indexed_at
    `)
    for (const story of stories) {
      // Corrupt legacy payloads must not make the whole picker unavailable.
      if (
        typeof story.storyId !== 'string' || !story.storyId || story.storyId.includes('\u0000') ||
        typeof story.name !== 'string' ||
        !Number.isSafeInteger(story.chunkCount) || story.chunkCount < 0 ||
        !Number.isSafeInteger(story.indexedAt)
      ) continue
      insert.run(userId, story.storyId, story.name, story.chunkCount, story.indexedAt)
    }
    db.prepare(`
      INSERT INTO indexed_story_catalog_state (user_id, stamp) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET stamp = excluded.stamp
    `).run(userId, stamp)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function listIndexedStoryPage(userId: number, rawLimit: unknown, rawCursor: unknown): IndexedStoryPage {
  const { limit, cursor } = parseStoryPage(rawLimit, rawCursor)
  refreshIndexCatalog(userId)
  const query = getDb().prepare(`
    SELECT story_id AS storyId, name, chunk_count AS chunkCount, indexed_at AS indexedAt
    FROM indexed_story_catalog WHERE user_id = ?
    ${cursor ? 'AND (indexed_at, story_id) < (?, ?)' : ''}
    ORDER BY indexed_at DESC, story_id DESC LIMIT ?
  `)
  const bindings = cursor ? [userId, ...cursor, limit + 1] : [userId, limit + 1]
  const rows = query.all(...bindings) as unknown as IndexedStory[]
  const last = rows[limit - 1]
  return {
    stories: rows.slice(0, limit),
    nextCursor: rows.length > limit && last ? encodeStoryCursor(last.indexedAt, last.storyId) : null,
  }
}
