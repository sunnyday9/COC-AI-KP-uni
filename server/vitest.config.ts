import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs before each test file's module graph loads: points DATA_DIR at a
    // fresh per-worker temp dir so tests never touch server/data/ai-kp.db.
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
  },
})
