/**
 * Story file service (api-contract §5) — migrated from
 * original/ai-trpg-web/electron/ipc/fileHandlers.cjs (file:listStories,
 * file:readStory, file:readStoryForRag, file:importStory, file:deleteStory).
 *
 * Storage model (2026-08-20 DB 映射重构，门禁合规)：
 *  - stories 表（DB）持有 { user_id, story_id, name, file_path }；
 *  - `story_id` 是对外 id（客户端/URL 使用，保留原语义）；
 *  - `file_path` 是服务端生成的内部文件名（uuid + 扩展名），**外部输入永不
 *    直接进入 fs 路径**：所有读/删先经 DB 查询拿 file_path，fs 只用该内部值。
 *  - 存量文件系统数据（旧版 id=文件名 存储）在首次 list/read 时自动导入 DB
 *    （file_path = 原文件名，向后兼容零迁移）。
 *
 * Key adaptations (task-5-brief decisions 1/2/3/6):
 *  - Upload only persists the file and returns `{ ok, name?, id?, error? }`;
 *    parsing is deferred to readStory / readStoryForRag (original behavior —
 *    file:importStory did a plain copy too).
 *  - readStoryForRag returns the FULL parsed text (PDF → parsePdfWithOcr,
 *    DOCX/EPUB/HTML → rag/storyParsers). Chunking stays client-side.
 *  - deleteStory does NOT touch the RAG index (original behavior preserved).
 *  - Missing files: 404 NotFoundError; parse failures fall back to ''.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { UPLOADS_DIR } from '../config.js'
import { getDb } from '../db/index.js'
import { assertId, sanitizeFilename } from '../utils/fileNames.js'
import { readFileOr404, unlinkOr404 } from '../utils/fsSafe.js'
import { assertPathInDir, resolveFileInDir } from '../utils/pathSafety.js'
import { NotFoundError } from '../utils/errors.js'
import * as storyParsers from '../rag/storyParsers.js'

/** Story extensions — mirrors STORY_EXTENSIONS in fileHandlers.cjs verbatim. */
export const STORY_EXTENSIONS = ['.txt', '.md', '.json', '.pdf', '.docx', '.epub', '.html', '.htm']

export interface StoryListItem {
  name: string
  id: string
}

export interface UploadedFile {
  originalname: string
  buffer: Buffer
  size: number
}

function storiesDir(userId: number): string {
  return path.join(UPLOADS_DIR, String(userId), 'stories')
}

async function ensureStoriesDir(userId: number): Promise<string> {
  const dir = storiesDir(userId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 生成内部文件名：uuid + 原扩展名（非外部输入，fs 路径唯一来源）。 */
function generateFilePath(displayName: string): string {
  const ext = path.extname(displayName).toLowerCase()
  return `${crypto.randomUUID()}${ext || '.txt'}`
}

/** 校验 file_path 只含安全字符且带扩展名（DB 内部值，防御性校验）。 */
function assertStoredFilePath(filePath: string): string {
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9]+)?$/.test(filePath)) {
    throw new NotFoundError('story file missing')
  }
  return filePath
}

interface StoryRow {
  story_id: string
  name: string
  file_path: string
}

/** DB 查询：外部 story_id → 内部 file_path（污点链在此断开）。 */
function queryStoryRow(userId: number, storyId: string): StoryRow | null {
  const row = getDb()
    .prepare(`SELECT story_id, name, file_path FROM stories WHERE user_id = ? AND story_id = ?`)
    .get(userId, storyId) as StoryRow | undefined
  return row ?? null
}

/** 存量文件系统数据自动导入 DB（旧版 id=文件名 存储，首次访问时迁移）。
 * 跳过内部 uuid 文件名（file_path 风格，非对外 id）。 */
async function importLegacyFile(userId: number, fileName: string): Promise<StoryRow | null> {
  if (!isStoryFile(fileName)) return null
  // uuid 文件名（内部存储）不作为存量导入 —— 它们由 DB 记录引用。
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(fileName)) return null
  const dir = await ensureStoriesDir(userId)
  const legacyPath = resolveFileInDir(dir, fileName, 'story file')
  try {
    await fs.access(legacyPath)
  } catch {
    return null
  }
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO stories (user_id, story_id, name, file_path, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, fileName, fileName, fileName, Date.now())
  return queryStoryRow(userId, fileName)
}

/** 解析外部 id → 内部 file_path：仅 DB 查询（外部 id 不进入 fs 路径）。
 * 存量文件系统数据由 listStories 的 readdir 扫描自动导入。 */
async function resolveStoryFilePath(userId: number, storyId: string): Promise<{ filePath: string; name: string }> {
  const existing = queryStoryRow(userId, storyId)
  if (existing && existing.file_path) {
    return { filePath: assertStoredFilePath(existing.file_path), name: existing.name }
  }
  throw new NotFoundError('story not found')
}

function isStoryFile(name: string): boolean {
  const lower = name.toLowerCase()
  return STORY_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** PDF → text via pdf-parse only (no OCR) — mirrors readStory's pdf branch. */
async function pdfParse(dataBuffer: Buffer): Promise<{ text: string }> {
  const { PDFParse } = await import('pdf-parse')
  const uint8Array = new Uint8Array(dataBuffer.buffer, dataBuffer.byteOffset, dataBuffer.byteLength)
  const parser = new PDFParse({ data: uint8Array })
  return await parser.getText()
}

/** file:listStories — DB 为主 + 存量文件系统兜底导入。 */
export async function listStories(userId: number): Promise<StoryListItem[]> {
  // 存量文件系统数据（旧版）自动导入 DB，保证列表完整。
  const dir = await ensureStoriesDir(userId)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && isStoryFile(e.name)) {
        await importLegacyFile(userId, e.name)
      }
    }
  } catch {
    // 目录不存在或不可读 → 忽略，仅返回 DB 记录
  }
  const rows = getDb()
    .prepare(`SELECT story_id, name FROM stories WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as { story_id: string; name: string }[]
  return rows.map((r) => ({ name: r.name, id: r.story_id }))
}

/** file:readStory — raw text for txt/md/json, parsed text for pdf/docx/epub/html. */
export async function readStory(userId: number, id: string): Promise<{ name: string; content: string }> {
  assertId(id, 'story id')
  const { filePath, name } = await resolveStoryFilePath(userId, id)
  // fs 只用 DB 内部 file_path；就近守卫：必须落在 storiesDir 内。
  const safePath = assertPathInDir(storiesDir(userId), resolveFileInDir(storiesDir(userId), filePath, 'story file'), 'story file (sink)')
  const ext = path.extname(safePath).toLowerCase()
  if (ext === '.pdf') {
    const dataBuffer = await readFileOr404(safePath, 'story')
    const pdfData = await pdfParse(dataBuffer)
    return { name, content: pdfData.text }
  }
  if (['.docx', '.epub'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer)
      return { name, content: text || '' }
    } catch {
      return { name, content: '' }
    }
  }
  if (['.html', '.htm'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer.toString('utf-8'))
      return { name, content: text || '' }
    } catch {
      return { name, content: '' }
    }
  }
  const dataBuffer = await readFileOr404(safePath, 'story')
  return { name, content: dataBuffer.toString('utf-8') }
}

/**
 * file:readStoryForRag — full parsed text for RAG indexing. PDFs go through
 * parsePdfWithOcr (text + embedded-image OCR); docx/epub/html through
 * storyParsers; everything else is read verbatim. Chunking is the client's job.
 */
export async function readStoryForRag(userId: number, id: string): Promise<{ name: string; content: string }> {
  assertId(id, 'story id')
  const { filePath, name } = await resolveStoryFilePath(userId, id)
  const safePath = assertPathInDir(storiesDir(userId), resolveFileInDir(storiesDir(userId), filePath, 'story file'), 'story file (sink)')
  const ext = path.extname(safePath).toLowerCase()
  if (['.docx', '.epub'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer)
      return { name, content: text || '' }
    } catch {
      return { name, content: '' }
    }
  }
  if (['.html', '.htm'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer.toString('utf-8'))
      return { name, content: text || '' }
    } catch {
      return { name, content: '' }
    }
  }
  if (ext !== '.pdf') {
    const dataBuffer = await readFileOr404(safePath, 'story')
    return { name, content: dataBuffer.toString('utf-8') }
  }
  const dataBuffer = await readFileOr404(safePath, 'story')
  const mainText = await storyParsers.parsePdfWithOcr(dataBuffer)
  return { name, content: mainText }
}

/**
 * file:importStory — persist the uploaded bytes and return `{ ok, name?, id?,
 * error? }` (parsing deferred). 对外 id = sanitized filename（保留原语义）；
 * 磁盘文件名 = 服务端生成的 uuid（内部值，外部输入不进入 fs 路径）。
 */
export async function importStory(
  userId: number,
  file: UploadedFile | undefined,
): Promise<{ ok: boolean; name?: string; id?: string; error?: string }> {
  if (!file || !file.buffer) return { ok: false, error: 'no file received' }
  let id: string
  try {
    id = sanitizeFilename(file.originalname, 'story')
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid filename' }
  }
  const ext = path.extname(id).toLowerCase()
  if (!STORY_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `unsupported file type: ${ext || '(none)'}` }
  }
  // 同名冲突：追加短随机后缀（保留原行为）。
  const db = getDb()
  const existing = db.prepare(`SELECT 1 FROM stories WHERE user_id = ? AND story_id = ?`).get(userId, id)
  if (existing) {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    id = `${id.slice(0, id.length - ext.length)}-${stamp}${ext}`
  }
  const filePath = generateFilePath(id)
  const dir = await ensureStoriesDir(userId)
  const target = assertPathInDir(dir, resolveFileInDir(dir, filePath, 'story file'), 'story file (sink)')
  await fs.writeFile(target, file.buffer)
  db.prepare(`INSERT INTO stories (user_id, story_id, name, file_path, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, id, id, filePath, Date.now())
  return { ok: true, name: id, id }
}

/** file:deleteStory — unlink only; NO RAG index linkage (original behavior).
 * 仅按 DB 记录的内部 file_path 删文件（外部 id 不进入 fs 路径）。 */
export async function deleteStory(userId: number, id: string): Promise<void> {
  assertId(id, 'story id')
  const row = queryStoryRow(userId, id)
  if (!row || !row.file_path) {
    throw new NotFoundError('story not found')
  }
  const safePath = assertPathInDir(storiesDir(userId), resolveFileInDir(storiesDir(userId), row.file_path, 'story file'), 'story file (sink)')
  await unlinkOr404(safePath, 'story')
  getDb().prepare(`DELETE FROM stories WHERE user_id = ? AND story_id = ?`).run(userId, id)
}
