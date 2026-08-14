import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

/** HTTP listen port (default 3000) */
export const PORT = Number(process.env.PORT ?? 3000)

/** JWT signing secret — MUST be overridden in production (see .env.example) */
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

/** Runtime data directory (SQLite db lives here); created automatically on first use */
export const DATA_DIR = path.resolve(fileURLToPath(new URL('../data', import.meta.url)))
