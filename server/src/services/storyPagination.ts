import { BadRequestError } from '../utils/errors.js'

export interface StoryPageRow {
  story_id: string
  name: string
  created_at: number | string
}

function decodeStoryCursor(cursor: unknown): [number, string] | null {
  if (cursor === undefined) return null
  try {
    // Legacy SQLite IDs may be unnormalized filenames. The keyset value is
    // bound to SQL, so it does not need to satisfy any path or route rules.
    // 2300 bytes allows a full 255-byte filename with JSON escaping.
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2300}$/.test(cursor)) throw new Error()
    const decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) throw new Error()
    const value: unknown = JSON.parse(decoded.toString('utf-8'))
    if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || typeof value[1] !== 'string' || !value[1] || value[1].includes('\u0000')) {
      throw new Error()
    }
    return [value[0], value[1]]
  } catch {
    throw new BadRequestError('invalid story cursor')
  }
}

export function parseStoryPage(rawLimit: unknown, rawCursor: unknown) {
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0
  if (limit < 1 || limit > 100) throw new BadRequestError('story limit must be between 1 and 100')
  return { limit, cursor: decodeStoryCursor(rawCursor) }
}

export function encodeStoryCursor(timestamp: number, storyId: string): string {
  return Buffer.from(JSON.stringify([timestamp, storyId])).toString('base64url')
}

export function formatStoryPage(rows: StoryPageRow[], limit: number) {
  const last = rows[limit - 1]
  return {
    stories: rows.slice(0, limit).map((row) => ({ id: row.story_id, name: row.name })),
    nextCursor: rows.length > limit && last
      ? encodeStoryCursor(Number(last.created_at), last.story_id)
      : null,
  }
}
