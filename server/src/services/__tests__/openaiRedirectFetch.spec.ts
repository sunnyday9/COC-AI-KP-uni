import { afterEach, describe, expect, it, vi } from 'vitest'
import { openaiChatAdapter } from '../llm/openaiChat.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI SDK outbound redirect guard', () => {
  it('uses the guarded fetch for a real SDK request and follows a safe redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://provider.example/v1/chat/completions' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'safe redirect worked' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await openaiChatAdapter(
      {
        protocol: 'openai_chat',
        baseUrl: 'https://provider.example/v1',
        model: 'test-model',
        apiKey: 'test-key',
      },
      { messages: [{ role: 'user', content: 'hello' }] },
    )

    expect(result.content).toBe('safe redirect worked')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/chat/completions')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/chat/completions')
  })
})
