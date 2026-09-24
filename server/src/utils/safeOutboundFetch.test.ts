import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeOutboundFetch } from './safeOutboundFetch.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('safeOutboundFetch', () => {
  it.each([
    'http://127.0.0.1/internal',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:7f00:1]/internal',
    'http://api.localhost./internal',
  ])('rejects a redirect to an unsafe host before making a request there: %s', async (location) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeOutboundFetch('https://provider.example/v1/models')).rejects.toThrow(/unsafe outbound host/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/models')
  })

  it('follows a legitimate same-origin redirect and returns the final response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/v1/models?page=2' } }))
      .mockResolvedValueOnce(new Response('models', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await safeOutboundFetch('https://provider.example/v1/models')

    expect(await response.text()).toBe('models')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/models?page=2')
  })

  it('allows a same-origin redirect when the source URL has a credential query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/v1/models?key=secret&page=2' } }))
      .mockResolvedValueOnce(new Response('models', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await safeOutboundFetch('https://provider.example/v1/models?key=secret')

    expect(await response.text()).toBe('models')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/models?key=secret&page=2')
  })

  it.each([
    'https://capture.example/collect?forwarded=secret',
    'https://capture.example/collect/secret',
  ])('rejects a cross-origin redirect for a credential-bearing URL before contacting it: %s', async (location) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeOutboundFetch('https://provider.example/v1/models?key=secret')).rejects.toThrow(
      /cross-origin redirect with URL credentials/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/models?key=secret')
  })

  it('keeps the cross-origin restriction after a same-origin redirect drops the credential query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/v1/models?page=2' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://capture.example/collect?secret=secret' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeOutboundFetch('https://provider.example/v1/models?key=secret')).rejects.toThrow(
      /cross-origin redirect with URL credentials/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/models?page=2')
  })

  it('rejects a cross-origin redirect after an earlier hop introduces URL credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/intermediate?key=secret' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://capture.example/leak?key=secret' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeOutboundFetch('https://provider.example/start')).rejects.toThrow(
      /cross-origin redirect with URL credentials/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/intermediate?key=secret')
  })

  it('rejects a credential-bearing cross-origin redirect from a clean source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://capture.example/leak?token=secret' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeOutboundFetch('https://provider.example/start')).rejects.toThrow(
      /cross-origin redirect with URL credentials/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('drops request credentials when following a public cross-origin redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example/models' } }))
      .mockResolvedValueOnce(new Response('models', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await safeOutboundFetch('https://provider.example/v1/models', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret' },
      body: JSON.stringify({ model: 'test' }),
    })

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://cdn.example/models')
    expect(init.method).toBe('GET')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    expect(new Headers(init.headers).has('x-api-key')).toBe(false)
    expect(init.body).toBeUndefined()
  })

  it('preserves the method and body for a same-origin 307 redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/v1/embeddings' } }))
      .mockResolvedValueOnce(new Response('embedding', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await safeOutboundFetch('https://provider.example/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
    })

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://provider.example/v1/embeddings')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(ReadableStream)
  })
})
