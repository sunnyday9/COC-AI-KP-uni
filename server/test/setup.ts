import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Test env bootstrap (runs before each test file in its own worker process).
 * - DATA_DIR → unique temp dir per worker → per-file DB isolation
 * - RAG_DATA_DIR / MODELS_DIR → same temp dir → RAG index/graph files and the
 *   embedding model cache stay out of server/data (tests never load real
 *   models: @huggingface/transformers is mocked in RAG specs)
 * - UPLOADS_DIR → same temp dir → uploaded story/script fixtures never touch
 *   server/uploads
 * - JWT_SECRET → deterministic test secret (also feeds AES key derivation)
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-server-test-'))
process.env.DATA_DIR = tmpDir
process.env.RAG_DATA_DIR = tmpDir
process.env.MODELS_DIR = tmpDir
process.env.UPLOADS_DIR = tmpDir
process.env.JWT_SECRET = 'test-secret-for-ai-coc-kp'
