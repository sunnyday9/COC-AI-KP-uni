import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEndpointBaseUrl } from '../lib/client.ts'

test('normalizeEndpointBaseUrl: 合法 http(s) 归一化（去尾斜杠、去凭据）', () => {
  assert.equal(normalizeEndpointBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1')
  assert.equal(normalizeEndpointBaseUrl('https://api.example.com/v1///'), 'https://api.example.com/v1')
  assert.equal(normalizeEndpointBaseUrl(' http://localhost:8080/v1 '), 'http://localhost:8080/v1')
  assert.equal(normalizeEndpointBaseUrl('https://user:pass@api.example.com/v1'), 'https://api.example.com/v1')
  assert.equal(normalizeEndpointBaseUrl('https://api.example.com'), 'https://api.example.com')
})

test('normalizeEndpointBaseUrl: 拒绝非 http(s) 协议与缺 hostname', () => {
  assert.throws(() => normalizeEndpointBaseUrl('file:///etc/passwd'), /协议只允许/)
  assert.throws(() => normalizeEndpointBaseUrl('ftp://x.com'), /协议只允许/)
  assert.throws(() => normalizeEndpointBaseUrl('javascript:alert(1)'), /协议只允许/)
  assert.throws(() => normalizeEndpointBaseUrl('not a url'), /无效的端点 URL/)
})
