/**
 * Outbound URL safety gate (Mimosa security constraint, mandatory).
 *
 * Any server-initiated request to an external URL (AI providers, embeddings,
 * model lists, etc.) MUST pass `assertSafeOutboundUrl` first
 * (see docs/api-contract.md §3 安全约束).
 *
 * Rules:
 *  - only http/https protocols
 *  - parsed via `new URL()`
 *  - rejects: localhost, loopback, private (10/8, 172.16/12, 192.168/16),
 *    link-local (169.254/16), reserved (0.0.0.0/8, 127/8), unspecified (::),
 *    IPv6 loopback (::1) and IPv4-mapped IPv6 forms of any of the above.
 *
 * Note: DNS names are NOT resolved here (no async lookup); the check covers
 * literal IPs and special hostnames. This is a deliberate, documented scope.
 */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Extract an embedded IPv4 literal from IPv4-mapped / IPv4-compatible IPv6
 * forms. Node's URL parser normalizes dotted forms to hex
 * (e.g. `::ffff:127.0.0.1` → `::ffff:7f00:1`), so both spellings must be decoded.
 * Returns null when the form is not an embedded-IPv4 pattern.
 */
export function ipv4FromIpv6Suffix(ipv6: string): string | null {
  const m = ipv6.match(/^::ffff:0:(.+)$/) || ipv6.match(/^::ffff:(.+)$/) || ipv6.match(/^::(.+)$/)
  if (!m) return null
  const tail = m[1]
  const dotted = tail.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return dotted[1]
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
  return null
}

export function isIpv4Literal(host: string): boolean {
  return IPV4_RE.test(host)
}

/**
 * Returns a human-readable reason when the IPv4 literal is unsafe, else null.
 */
export function unsafeIpv4Reason(ip: string): string | null {
  const parts = ip.split('.').map(Number)
  const [a, b] = parts
  if (a === 10) return 'private address (10/8) is not allowed'
  if (a === 172 && b >= 16 && b <= 31) return 'private address (172.16/12) is not allowed'
  if (a === 192 && b === 168) return 'private address (192.168/16) is not allowed'
  if (a === 169 && b === 254) return 'link-local address (169.254/16) is not allowed'
  if (a === 0) return 'reserved address (0.0.0.0/8) is not allowed'
  if (a === 127) return 'loopback address (127/8) is not allowed'
  return null
}

function assertSafeIpv4(ip: string, host: string): void {
  if (!IPV4_RE.test(ip)) {
    throw new Error(`unsafe outbound host: invalid embedded IPv4 in ${host}`)
  }
  const reason = unsafeIpv4Reason(ip)
  if (reason) throw new Error(`unsafe outbound host: ${reason}`)
}

/**
 * Throws when `raw` is not a safe outbound URL; returns normally otherwise.
 */
export function assertSafeOutboundUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('unsafe outbound url: invalid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsafe outbound url: protocol must be http or https (got ${url.protocol})`)
  }

  const host = url.hostname
  let h = host
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1)
  }
  const lower = h.toLowerCase()

  if (lower === 'localhost') {
    throw new Error('unsafe outbound host: localhost is not allowed')
  }
  if (lower === '::' || lower === '::1') {
    throw new Error('unsafe outbound host: IPv6 unspecified/loopback is not allowed')
  }

  const mapped = lower.match(/^::/)
  if (mapped && lower !== '::' && lower !== '::1') {
    // IPv4-mapped / IPv4-compatible / translated forms — decode embedded IPv4
    const embedded = ipv4FromIpv6Suffix(lower)
    if (embedded !== null) {
      assertSafeIpv4(embedded, host)
    }
    return
  }
  if (lower.includes(':')) {
    // Other literal IPv6 (e.g. public addresses) — not a private/loopback form we reject.
    return
  }
  if (IPV4_RE.test(lower)) {
    assertSafeIpv4(lower, host)
    return
  }
  // DNS hostname (e.g. api.openai.com) — allowed; no DNS resolution performed here.
}
