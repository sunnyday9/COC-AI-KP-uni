import { createRequire } from 'node:module'

/**
 * COC KP tool definitions (OpenAI function-calling format).
 *
 * Single source of truth: `shared/tools/cocTools.cjs` (migrated in Task 1,
 * byte-identical to the original `electron/ipc/aiHandlers.cjs` COC_KP_TOOLS —
 * verified by diff). The server loads it via createRequire because it is a
 * plain .cjs module outside the tsc compilation graph; the build script copies
 * shared/tools into dist so the same relative path resolves at runtime.
 */
export interface KpToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const require = createRequire(import.meta.url)
const mod = require('../../../shared/tools/cocTools.cjs') as { COC_KP_TOOLS: KpToolDef[] }

export const COC_KP_TOOLS: KpToolDef[] = mod.COC_KP_TOOLS
