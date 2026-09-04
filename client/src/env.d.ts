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

// T4 组件测试（ChatMessage.spec.ts）直接 import .vue —— uni 构建期由编译器处理，
// tsc --noEmit（CI 步骤）则需要 ambient 模块声明才能解析。仅类型层，不影响运行时。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
