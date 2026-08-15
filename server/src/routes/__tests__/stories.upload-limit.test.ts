// @vitest-environment node
/**
 * Upload size limit (api-contract §10: stories/scripts ≤ 50MB) exercised with
 * a mocked, tiny MAX_UPLOAD_BYTES so the test never allocates 50MB buffers.
 * The mock must be active before the routes module reads the constant.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>()
  return { ...actual, MAX_UPLOAD_BYTES: 2048 }
})

import request from 'supertest'
import { createApp } from '../../app.js'
import { TEST_PASSWORD } from '../../testHelpers.js'

async function registerToken(username: string): Promise<string> {
  const res = await request(createApp()).post('/api/auth/register').send({ username, password: TEST_PASSWORD })
  expect(res.status).toBe(200)
  return res.body.token as string
}

describe('upload size limit', () => {
  it('stories: file above the limit is rejected with 413', async () => {
    const token = await registerToken('limit_stories')
    const res = await request(createApp())
      .post('/api/stories/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.alloc(4096), 'big.txt')
    expect(res.status).toBe(413)
    expect(res.body.error).toContain('file too large')
  })

  it('scripts: file above the limit is rejected with 413', async () => {
    const token = await registerToken('limit_scripts')
    const res = await request(createApp())
      .post('/api/scripts/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.alloc(4096), 'big.json')
    expect(res.status).toBe(413)
    expect(res.body.error).toContain('file too large')
  })

  it('small files still upload under the limit', async () => {
    const token = await registerToken('limit_small')
    const res = await request(createApp())
      .post('/api/stories/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('ok', 'utf-8'), 'small.txt')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: 'small.txt' })
  })
})
