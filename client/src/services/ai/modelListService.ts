import { getBridge } from '../../platform'

export interface ModelOption {
  value: string
  label: string
}

interface FetchContext {
  apiKey?: string
  baseUrl?: string
}

/**
 * Migrated from `window.electronAPI.aiListModels` to `getBridge().aiListModels`
 * (Task 7). Adjustment: `protocol`/`baseUrl`/`apiKey` no longer travel to the
 * wire — the server proxies model listing using the user's stored AI config
 * (api-contract §3, outbound URL validation included). The original
 * non-Electron fallback (direct fetch to arbitrary provider URLs with the
 * apiKey) is removed: the Bridge always exists, and the fallback bypassed the
 * server's outbound-URL guard.
 *
 * The `protocol`/`context` parameters are kept for call-site compatibility
 * (Settings UI, Task 8 / ADR-0003) and are not used.
 */
export async function getModelOptions(
  protocol: string,
  context: FetchContext,
  purpose: 'chat' | 'embeddings' = 'chat',
): Promise<ModelOption[]> {
  void protocol
  void context
  return await getBridge().aiListModels({ purpose })
}
