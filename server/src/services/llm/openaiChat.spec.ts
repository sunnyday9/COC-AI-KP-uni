import { afterEach, describe, expect, it, vi } from 'vitest'
import { openaiChatAdapter } from './openaiChat.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openaiChatAdapter endpoint handling', () => {
  it('accepts a full Chat Completions URL from the settings form', async () => {
    let outboundUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        outboundUrl = input instanceof Request ? input.url : String(input)
        if (outboundUrl.endsWith('/chat/completions/chat/completions')) {
          return new Response(null, { status: 404, statusText: 'Not Found' })
        }
        return Response.json({ choices: [{ message: { content: 'OK' } }] })
      }),
    )

    const result = await openaiChatAdapter(
      {
        protocol: 'openai_chat',
        baseUrl: 'https://api.commandcode.ai/provider/v1/chat/completions',
        model: 'fixture-model',
        apiKey: 'fixture-not-a-secret',
      },
      { messages: [{ role: 'user', content: 'connection check' }], stream: false },
    )

    expect(outboundUrl).toBe('https://api.commandcode.ai/provider/v1/chat/completions')
    expect(result).toMatchObject({ stream: false, content: 'OK' })
  })
})
