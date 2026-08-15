import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import { getDb } from '../db/index.js'
import { TEST_PASSWORD, TEST_PASSWORD_SHORT, TEST_PASSWORD_WRONG } from '../testHelpers.js'

/**
 * Auth route tests (api-contract §1): register / login / me.
 * DB is isolated per test file via vitest setup (temp DATA_DIR).
 */

function makeAgent() {
  return request(createApp())
}

async function registerUser(username: string, password = TEST_PASSWORD) {
  const res = await makeAgent().post('/api/auth/register').send({ username, password })
  return res
}

describe('auth routes', () => {
  it('register succeeds with token + user', async () => {
    const res = await registerUser('alice')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      user: { id: expect.any(Number), username: 'alice' },
    })
    expect(typeof res.body.token).toBe('string')
  })

  it('register with duplicate username returns 409', async () => {
    await registerUser('bob')
    const res = await registerUser('bob')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'username already taken' })
  })

  it('register with too-short username returns 400', async () => {
    const res = await registerUser('ab')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/username must be 3-32 characters/)
  })

  it('register with too-long username returns 400', async () => {
    const res = await registerUser('a'.repeat(33))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/username must be 3-32 characters/)
  })

  it('register with too-short password returns 400', async () => {
    const res = await makeAgent().post('/api/auth/register').send({ username: 'carol', password: TEST_PASSWORD_SHORT })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/password must be at least 6 characters/)
  })

  it('login succeeds with valid credentials', async () => {
    await registerUser('dave')
    const res = await makeAgent().post('/api/auth/login').send({ username: 'dave', password: TEST_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ user: { username: 'dave' } })
    expect(typeof res.body.token).toBe('string')
  })

  it('login with wrong password returns 401', async () => {
    await registerUser('erin')
    const res = await makeAgent().post('/api/auth/login').send({ username: 'erin', password: TEST_PASSWORD_WRONG })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'invalid username or password' })
  })

  it('login with unknown user returns 401', async () => {
    const res = await makeAgent().post('/api/auth/login').send({ username: 'ghost', password: TEST_PASSWORD })
    expect(res.status).toBe(401)
  })

  it('GET /api/auth/me without token returns 401', async () => {
    const res = await makeAgent().get('/api/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('GET /api/auth/me with token returns the user', async () => {
    const reg = await registerUser('frank')
    const res = await makeAgent().get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ user: { id: reg.body.user.id, username: 'frank' } })
  })

  it('password is stored as a bcrypt hash, not plaintext', async () => {
    await registerUser('grace')
    const row = getDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('grace') as {
      password_hash: string
    }
    expect(row.password_hash.startsWith('$2')).toBe(true)
    expect(row.password_hash).not.toContain(TEST_PASSWORD)
  })
})
