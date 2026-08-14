/// <reference types="vite/client" />

/**
 * Vite env typing for the platform layer (Task 6).
 * `VITE_API_BASE` — backend base URL:
 *   - H5: relative `/api` (same-origin; vite dev proxy wired in Task 11) or absolute URL
 *   - mp-weixin / app: MUST be an absolute URL, e.g. `https://your-server.com`
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
