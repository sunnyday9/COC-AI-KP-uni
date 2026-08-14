import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from './app.js'

describe('app smoke', () => {
  it('GET unknown path returns 404 JSON with { error }', async () => {
    const res = await request(createApp()).get('/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('returns JSON content-type for 404', async () => {
    const res = await request(createApp()).get('/nope')
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })

  it.each([
    ['POST', '/api/auth/register'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/auth/me'],
    ['GET', '/api/settings'],
    ['PUT', '/api/settings'],
    ['POST', '/api/ai/chat'],
    ['GET', '/api/ai/models'],
    ['POST', '/api/kp/invoke'],
    ['GET', '/api/stories'],
    ['POST', '/api/stories/upload'],
    ['GET', '/api/scripts'],
    ['GET', '/api/saves'],
    ['GET', '/api/rag/health'],
    ['POST', '/api/rag/index'],
  ])('%s %s returns 501 not implemented', async (method, route) => {
    const res = await request(createApp())[method.toLowerCase() as 'get'](route)
    expect(res.status).toBe(501)
    expect(res.body).toEqual({ error: 'not implemented' })
  })
})
