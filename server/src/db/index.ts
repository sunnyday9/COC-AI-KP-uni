import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config.js'
import { migrateDatabase } from './migrations.js'

let db: DatabaseSync | null = null

/**
 * Singleton SQLite connection (Node 24 built-in node:sqlite, zero native deps).
 * Creates DATA_DIR and applies versioned schema migrations before exposing the connection.
 */
export function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const connection = new DatabaseSync(path.join(DATA_DIR, 'ai-kp.db'))
    try {
      // WAL + busy_timeout：Windows 高频快照写（房间定时 persistSnapshot）在
      // 默认 delete journal 下多次触发 SQLite disk I/O error(266)；WAL 允许
      // 读写并发并显著降低锁/IO 竞争（node:sqlite 内建支持）。
      connection.exec(`PRAGMA journal_mode = WAL`)
      connection.exec(`PRAGMA busy_timeout = 5000`)
      migrateDatabase(connection)
      db = connection
    } catch (error) {
      try {
        connection.close()
      } catch {
        // Preserve the initialization/migration error as the actionable cause.
      }
      throw error
    }
  }
  return db
}
