import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    uni(),
  ],
  server: {
    // Allow importing the shared/ package (outside client root) via relative paths
    fs: {
      allow: ['..'],
    },
    // H5 dev port (Task 11): fixed so the E2E journey (e2e/h5.journey.mjs)
    // defaults to http://localhost:5175. E2E overrides with E2E_WEB_BASE.
    port: 5175,
    // Explicit IPv4 loopback: Vite 5 defaults to `::1` on Node 17+ which can
    // fail with EACCES (IPv6 bind restrictions) — see test-agent REPORT.md.
    host: '127.0.0.1',
    // Dev proxy (Task 11): H5 dev defaults to same-origin /api + /ws against
    // the local backend on :3000. E2E sets VITE_API_BASE instead, which the
    // bridge prefers over these relative defaults.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
