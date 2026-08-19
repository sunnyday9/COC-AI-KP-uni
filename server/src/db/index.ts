import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config.js'

let db: DatabaseSync | null = null

/**
 * Singleton SQLite connection (Node 24 built-in node:sqlite, zero native deps).
 * Creates DATA_DIR and all tables on first use.
 */
export function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    db = new DatabaseSync(path.join(DATA_DIR, 'ai-kp.db'))
    initSchema(db)
  }
  return db
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saves (
      user_id INTEGER NOT NULL,
      save_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, save_id)
    );
    CREATE TABLE IF NOT EXISTS scripts (
      user_id INTEGER NOT NULL,
      script_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, script_id)
    );
    CREATE TABLE IF NOT EXISTS stories (
      user_id INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, story_id)
    );
    CREATE TABLE IF NOT EXISTS rag_index (
      user_id INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, story_id)
    );
    CREATE TABLE IF NOT EXISTS user_graphs (
      user_id INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, story_id, session_id)
    );
  `)
  // 幂等迁移：旧库的 stories 表没有 file_path 列（DB 映射重构，2026-08-20）。
  const storyCols = database.prepare(`PRAGMA table_info(stories)`).all() as { name: string }[]
  if (!storyCols.some((c) => c.name === 'file_path')) {
    database.exec(`ALTER TABLE stories ADD COLUMN file_path TEXT NOT NULL DEFAULT ''`)
  }
  const scriptCols = database.prepare(`PRAGMA table_info(scripts)`).all() as { name: string }[]
  if (!scriptCols.some((c) => c.name === 'file_path')) {
    database.exec(`ALTER TABLE scripts ADD COLUMN file_path TEXT NOT NULL DEFAULT ''`)
  }
}
