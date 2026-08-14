import type { AIProviderConfig, ChatRequest, ChatResponse, ChatStream } from './types'
import { getBridge } from '../../platform'

/**
 * Migrated from `window.electronAPI.aiChat` to `getBridge().aiChat` (Task 7).
 * Adjustment: provider/model/baseUrl/apiKey are no longer sent — the server
 * reads the user's AI config from its own settings store (api-contract §3),
 * so this call only carries messages + temperature/maxTokens/stream.
 */
export async function chat(config: AIProviderConfig, request: ChatRequest): Promise<ChatResponse | ChatStream> {
  const result = await getBridge().aiChat({
    messages: request.messages,
    temperature: config.temperature ?? request.temperature,
    maxTokens: request.maxTokens ?? config.maxTokens,
    stream: request.stream ?? false,
  })
  if (result?.stream && result.chunks) {
    return (async function* () {
      for (const c of result.chunks!) yield c
    })()
  }
  return { content: result?.content ?? '' }
}

export function isStreamResponse(result: ChatResponse | ChatStream): result is ChatStream {
  return typeof (result as AsyncIterable<string>)[Symbol.asyncIterator] === 'function'
}

export async function consumeStream(stream: ChatStream): Promise<string> {
  let full = ''
  for await (const chunk of stream) {
    full += chunk
  }
  return full
}
