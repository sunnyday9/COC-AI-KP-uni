import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from './app.js'

describe('app smoke', () => {
  it.each(['', 'dev-secret-change-me'])('refuses to create the app in production with an unsafe JWT_SECRET (%s)', (secret) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JWT_SECRET', secret)

    try {
      expect(() => createApp()).toThrow('JWT_SECRET must be set to a non-default value in production')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('GET unknown path returns 404 JSON with { error }', async () => {
    const res = await request(createApp()).get('/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('returns JSON content-type for 404', async () => {
    const res = await request(createApp()).get('/nope')
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })

  // Task 2 implemented routes: auth (no auth needed for register/login),
  // protected endpoints answer 401 without a token, invalid bodies 400.
  it('POST /api/auth/register with empty body returns 400', async () => {
    const res = await request(createApp()).post('/api/auth/register').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('POST /api/auth/login with empty body returns 400', async () => {
    const res = await request(createApp()).post('/api/auth/login').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it.each([
    ['GET', '/api/auth/me'],
    ['GET', '/api/settings'],
    ['PUT', '/api/settings'],
    ['POST', '/api/ai/chat'],
    ['GET', '/api/ai/models'],
    ['GET', '/api/rag/health'],
    ['POST', '/api/rag/index'],
    ['POST', '/api/rag/query'],
    ['GET', '/api/stories'],
    ['POST', '/api/stories/upload'],
  ])('%s %s without token returns 401', async (method, route) => {
    const res = await request(createApp())[method.toLowerCase() as 'get'](route)
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })
})
