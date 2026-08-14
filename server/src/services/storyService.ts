/**
 * Story file service (api-contract §5) — migrated from
 * original/ai-trpg-web/electron/ipc/fileHandlers.cjs (file:listStories,
 * file:readStory, file:readStoryForRag, file:importStory, file:deleteStory).
 *
 * Key adaptations (task-5-brief decisions 1/2/3/6):
 *  - File paths are replaced by server-generated ids; storage is
 *    `UPLOADS_DIR/<userId>/stories/<id>` (per-user isolation, id = sanitized
 *    filename incl. extension — see id generation notes in the report).
 *  - Upload only persists the file and returns `{ ok, name?, id?, error? }`;
 *    parsing is deferred to readStory / readStoryForRag (original behavior —
 *    file:importStory did a plain copy too).
 *  - readStoryForRag returns the FULL parsed text (PDF → parsePdfWithOcr,
 *    DOCX/EPUB/HTML → rag/storyParsers). Chunking stays client-side
 *    (original src/services/storyService.ts is a client file; the client
 *    calls fileToChunks after readStoryForRag) — the server never chunks.
 *  - deleteStory does NOT touch the RAG index — the original file:deleteStory
 *    only unlinked the file; RAG index deletion was a separate client call
 *    (ScriptListView → ragDelete). Behavior preserved.
 *  - Missing files: original rejected with ENOENT (and the docx/epub/html
 *    parse branches swallowed read errors into ''); here a missing file is a
 *    404 NotFoundError while parse failures still fall back to '' (the
 *    original's intentional swallow is kept for parse errors only).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { UPLOADS_DIR } from '../config.js'
import { assertId, sanitizeFilename } from '../utils/fileNames.js'
import { readFileOr404, unlinkOr404 } from '../utils/fsSafe.js'
import { resolveFileInDir } from '../utils/pathSafety.js'
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

function resolveStoryFile(userId: number, id: string): string {
  return resolveFileInDir(storiesDir(userId), id, 'story file')
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

/** file:listStories — readdir filtered by STORY_EXTENSIONS. */
export async function listStories(userId: number): Promise<StoryListItem[]> {
  try {
    const entries = await fs.readdir(storiesDir(userId), { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && isStoryFile(e.name))
      .map((e) => ({ name: e.name, id: e.name }))
  } catch {
    return [] // mirrors the original listStories catch → []
  }
}

/** file:readStory — raw text for txt/md/json, parsed text for pdf/docx/epub/html. */
export async function readStory(userId: number, id: string): Promise<{ name: string; content: string }> {
  assertId(id, 'story id')
  const safePath = resolveStoryFile(userId, id)
  const ext = path.extname(safePath).toLowerCase()
  if (ext === '.pdf') {
    const dataBuffer = await readFileOr404(safePath, 'story')
    const pdfData = await pdfParse(dataBuffer)
    return { name: id, content: pdfData.text }
  }
  if (['.docx', '.epub'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer)
      return { name: id, content: text || '' }
    } catch {
      return { name: id, content: '' }
    }
  }
  if (['.html', '.htm'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer.toString('utf-8'))
      return { name: id, content: text || '' }
    } catch {
      return { name: id, content: '' }
    }
  }
  const dataBuffer = await readFileOr404(safePath, 'story')
  return { name: id, content: dataBuffer.toString('utf-8') }
}

/**
 * file:readStoryForRag — full parsed text for RAG indexing. PDFs go through
 * parsePdfWithOcr (text + embedded-image OCR); docx/epub/html through
 * storyParsers; everything else is read verbatim. Chunking is the client's
 * job (see module header).
 */
export async function readStoryForRag(userId: number, id: string): Promise<{ name: string; content: string }> {
  assertId(id, 'story id')
  const safePath = resolveStoryFile(userId, id)
  const ext = path.extname(safePath).toLowerCase()
  if (['.docx', '.epub'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer)
      return { name: id, content: text || '' }
    } catch {
      return { name: id, content: '' }
    }
  }
  if (['.html', '.htm'].includes(ext)) {
    const dataBuffer = await readFileOr404(safePath, 'story')
    try {
      const text = await storyParsers.parseByExtension(ext, dataBuffer.toString('utf-8'))
      return { name: id, content: text || '' }
    } catch {
      return { name: id, content: '' }
    }
  }
  if (ext !== '.pdf') {
    const dataBuffer = await readFileOr404(safePath, 'story')
    return { name: id, content: dataBuffer.toString('utf-8') }
  }
  const dataBuffer = await readFileOr404(safePath, 'story')
  const mainText = await storyParsers.parsePdfWithOcr(dataBuffer)
  return { name: id, content: mainText }
}

/**
 * file:importStory — persist the uploaded bytes and return `{ ok, name?, id?,
 * error? }` (parsing deferred). Id = sanitized filename incl. extension; on a
 * name conflict a short random/timestamp suffix is appended (decision 1 —
 * the original silently overwrote; the brief mandates conflict suffixes).
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
  const dir = await ensureStoriesDir(userId)
  let target = path.join(dir, id)
  while (await exists(target)) {
    id = uniqueId(id)
    target = path.join(dir, id)
  }
  await fs.writeFile(target, file.buffer)
  return { ok: true, name: id, id }
}

/** file:deleteStory — unlink only; NO RAG index linkage (original behavior). */
export async function deleteStory(userId: number, id: string): Promise<void> {
  assertId(id, 'story id')
  const safePath = resolveStoryFile(userId, id)
  await unlinkOr404(safePath, 'story')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Append a short timestamp+random suffix before the extension (decision 1). */
function uniqueId(id: string): string {
  const ext = path.extname(id)
  const base = ext ? id.slice(0, id.length - ext.length) : id
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return `${base}-${stamp}${ext}`
}
