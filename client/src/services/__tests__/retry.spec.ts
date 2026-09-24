import { describe, expect, it, vi } from 'vitest'
import { BridgeError } from '../../platform/bridge'
import { retryTransientRequest } from '../retry'

describe('retryTransientRequest', () => {
  it('retries a network failure with the same operation closure and then succeeds', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new BridgeError('网络错误：timeout', { networkError: true }))
      .mockResolvedValueOnce({ ok: true })
    const wait = vi.fn(async () => {})

    await expect(retryTransientRequest(request, { wait, random: () => 0 })).resolves.toEqual({ ok: true })
    expect(request).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(400)
  })

  it('does not retry permanent 4xx responses', async () => {
    const request = vi.fn().mockRejectedValue(new BridgeError('story not found', { statusCode: 404 }))
    await expect(retryTransientRequest(request, { wait: async () => {} })).rejects.toThrow('story not found')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stops after the configured attempt budget for retryable failures', async () => {
    const request = vi.fn().mockRejectedValue(new BridgeError('server error', { statusCode: 503 }))
    await expect(retryTransientRequest(request, { maxAttempts: 3, wait: async () => {}, random: () => 0 })).rejects.toThrow('server error')
    expect(request).toHaveBeenCalledTimes(3)
  })
})
