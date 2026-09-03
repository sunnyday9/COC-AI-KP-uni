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
    // WAL + busy_timeout：Windows 高频快照写（房间定时 persistSnapshot）在
    // 默认 delete journal 下多次触发 SQLite disk I/O error(266)；WAL 允许
    // 读写并发并显著降低锁/IO 竞争（node:sqlite 内建支持）。
    db.exec(`PRAGMA journal_mode = WAL`)
    db.exec(`PRAGMA busy_timeout = 5000`)
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
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      story_id TEXT,
      kind TEXT NOT NULL DEFAULT 'multi',
      phase TEXT NOT NULL DEFAULT 'lobby',
      state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sheet TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      character_id TEXT,
      PRIMARY KEY (room_id, user_id)
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
  // 幂等迁移：旧库的 rooms 表没有 kind 列（ADR-0002 单人=单成员房间）。
  const roomCols = database.prepare(`PRAGMA table_info(rooms)`).all() as { name: string }[]
  if (!roomCols.some((c) => c.name === 'kind')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'multi'`)
  }
  // 幂等迁移：旧库的 room_members 表没有 ready 列（ADR-0005 等待室就绪软信号）。
  const memberCols = database.prepare(`PRAGMA table_info(room_members)`).all() as { name: string }[]
  if (!memberCols.some((c) => c.name === 'ready')) {
    database.exec(`ALTER TABLE room_members ADD COLUMN ready INTEGER NOT NULL DEFAULT 0`)
  }
}
