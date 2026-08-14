import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs before each test file's module graph loads: points DATA_DIR at a
    // fresh per-worker temp dir so tests never touch server/data/ai-kp.db.
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    // Never run compiled test copies from dist/ (tsc emits spec/test files
    // too); otherwise `npm test` after `npm run build` runs them twice.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
})
