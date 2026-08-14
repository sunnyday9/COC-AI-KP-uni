import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

/** HTTP listen port (default 3000) */
export const PORT = Number(process.env.PORT ?? 3000)

/** JWT signing secret — MUST be overridden in production (see .env.example) */
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

/**
 * Runtime data directory (SQLite db lives here); created automatically on
 * first use. `DATA_DIR` env overrides the default (used by tests to isolate
 * their database into a temp dir).
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(fileURLToPath(new URL('../data', import.meta.url)))
