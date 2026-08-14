import { describe, expect, it } from 'vitest'
import { assertSafeOutboundUrl } from './outboundUrl.js'

describe('assertSafeOutboundUrl', () => {
  it.each([
    'http://example.com',
    'https://example.com',
    'https://api.openai.com/v1/chat/completions',
    'https://example.com:8443/path?q=1',
    'http://11.22.33.44',
    'http://172.32.0.1',
    'http://100.64.0.1',
    'http://[2001:db8::1]',
    'https://[2606:4700:4700::1111]/',
  ])('accepts %s', (url) => {
    expect(() => assertSafeOutboundUrl(url)).not.toThrow()
  })

  it.each([
    'http://localhost',
    'http://localhost:3000',
    'https://localhost/api',
    'http://127.0.0.1',
    'http://127.255.255.255',
    'http://10.0.0.1',
    'http://10.255.255.255',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1',
    'http://169.254.169.254', // cloud metadata endpoint
    'http://0.0.0.0',
    'http://0.1.2.3',
    'http://[::1]',
    'http://[::]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:10.0.0.1]',
    'http://[::ffff:192.168.0.1]',
    'http://[::ffff:169.254.169.254]',
    // hex-form mapped addresses (Node URL normalization output)
    'http://[::ffff:7f00:1]',
    'http://[::ffff:a00:1]',
    'http://[::ffff:a9fe:a9fe]',
    'http://[::ffff:0:7f00:1]',
    // IPv4-compatible form
    'http://[::127.0.0.1]',
    // Unique local addresses fc00::/7 (RFC 4193)
    'http://[fc00::1]',
    'http://[fd00::1]',
    'http://[fd12:3456::789a]',
    'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
    // Link-local fe80::/10
    'http://[fe80::1]',
    'http://[febf::1]',
  ])('rejects %s', (url) => {
    expect(() => assertSafeOutboundUrl(url)).toThrow()
  })

  it('rejects non-http(s) protocols', () => {
    expect(() => assertSafeOutboundUrl('ftp://example.com')).toThrow(/protocol/)
    expect(() => assertSafeOutboundUrl('file:///etc/passwd')).toThrow(/protocol/)
    expect(() => assertSafeOutboundUrl('ws://example.com')).toThrow(/protocol/)
  })

  it('rejects malformed URLs', () => {
    expect(() => assertSafeOutboundUrl('not a url')).toThrow(/invalid URL/)
    expect(() => assertSafeOutboundUrl('')).toThrow()
  })

  it('rejects protocol-relative and userinfo tricks', () => {
    // '//127.0.0.1' has no protocol -> invalid or file-ish; must not be treated as http
    expect(() => assertSafeOutboundUrl('//127.0.0.1/path')).toThrow()
  })
})
