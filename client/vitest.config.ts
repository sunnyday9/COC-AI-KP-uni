import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // Pure-logic tests migrated from the original repo (node environment, no DOM).
  test: {
    // Pure-logic tests stay in node env (no DOM). Component tests (ChatMessage.spec.ts)
    // need a DOM for mounting .vue — jsdom is present transitively.
    environment: 'node',
    environmentMatchGlobs: [['src/pages/**/*.spec.ts', 'jsdom']],
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
  },
  server: {
    // Allow importing the shared/ package (outside client root) via relative paths
    fs: {
      allow: ['..'],
    },
  },
})
