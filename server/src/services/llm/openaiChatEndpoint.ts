/** Remove the operation path when a user pastes a complete Chat Completions URL. */
export function normalizeOpenAiChatBaseUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
}
