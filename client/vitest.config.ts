import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pure-logic tests migrated from the original repo (node environment, no DOM).
  test: {
    environment: 'node',
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
  },
  server: {
    // Allow importing the shared/ package (outside client root) via relative paths
    fs: {
      allow: ['..'],
    },
  },
})
