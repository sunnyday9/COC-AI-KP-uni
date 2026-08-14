import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Test env bootstrap (runs before each test file in its own worker process).
 * - DATA_DIR → unique temp dir per worker → per-file DB isolation
 * - JWT_SECRET → deterministic test secret (also feeds AES key derivation)
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikp-server-test-'))
process.env.DATA_DIR = tmpDir
process.env.JWT_SECRET = 'test-secret-for-ai-coc-kp'
