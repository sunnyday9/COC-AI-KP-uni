import { assertSafeOutboundUrl } from './outboundUrl.js'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-opencode-session',
]
const URL_CREDENTIAL_QUERY_NAMES = new Set([
  'api-key',
  'api_key',
  'apikey',
  'access_token',
  'client_secret',
  'key',
  'token',
  'x-api-key',
  'x-goog-api-key',
  'x-opencode-session',
])
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-length', 'content-location', 'content-type', 'transfer-encoding']

type FetchInitWithDuplex = RequestInit & { duplex?: 'half' }

function toFetchInit(request: Request): FetchInitWithDuplex {
  const init: FetchInitWithDuplex = {
    method: request.method,
    headers: request.headers,
    redirect: 'manual',
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  }

  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.clone().body
    init.duplex = 'half'
  }

  return init
}

function hasUrlCredentialQuery(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (URL_CREDENTIAL_QUERY_NAMES.has(name.toLowerCase())) return true
  }
  return false
}

/**
 * Fetch an outbound URL while checking every redirect destination before it is
 * contacted. Node's default fetch behavior follows redirects automatically,
 * which would otherwise bypass the configured-URL host check.
 */
export async function safeOutboundFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let request = new Request(input, init)
  assertSafeOutboundUrl(request.url)
  // A redirect can introduce a credential query even when the configured URL
  // did not have one. Once seen, keep the cross-origin restriction for the
  // rest of the chain, including redirects that later drop the query.
  let hasUrlCredentialsInChain = hasUrlCredentialQuery(new URL(request.url))

  // Keep the original argument shapes on the initial request so existing
  // fetch implementations and adapter tests retain their normal behavior.
  let fetchInput: RequestInfo | URL = input instanceof Request ? request.clone() : input
  let fetchInit: RequestInit = input instanceof Request ? { redirect: 'manual' } : { ...init, redirect: 'manual' }
  let redirects = 0

  while (true) {
    const response = await globalThis.fetch(fetchInput, fetchInit)
    const location = response.headers?.get?.('location')
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response

    try {
      await response.body?.cancel()
    } catch {
      // A response body may already be closed; the redirect still needs checking.
    }

    if (redirects >= MAX_REDIRECTS) throw new Error('unsafe outbound redirect: too many redirects')

    let target: URL
    try {
      target = new URL(location, request.url)
    } catch {
      throw new Error('unsafe outbound redirect url: invalid Location')
    }
    assertSafeOutboundUrl(target.href)

    const headers = new Headers(request.headers)
    let method = request.method
    let dropBody = false
    if ((response.status === 301 || response.status === 302) && method === 'POST') {
      method = 'GET'
      dropBody = true
    } else if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET'
      dropBody = true
    }

    if (dropBody) {
      for (const name of BODY_HEADERS) headers.delete(name)
    }

    const source = new URL(request.url)
    const targetHasUrlCredentials = hasUrlCredentialQuery(target)
    if (source.origin !== target.origin) {
      if (hasUrlCredentialsInChain || targetHasUrlCredentials) {
        throw new Error('unsafe outbound redirect: cross-origin redirect with URL credentials is not allowed')
      }
      for (const name of CROSS_ORIGIN_CREDENTIAL_HEADERS) headers.delete(name)
    }

    hasUrlCredentialsInChain ||= targetHasUrlCredentials

    const nextInit: FetchInitWithDuplex = {
      method,
      headers,
      redirect: 'manual',
      signal: request.signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    }
    if (!dropBody && request.body && method !== 'GET' && method !== 'HEAD') {
      nextInit.body = request.clone().body
      nextInit.duplex = 'half'
    }

    request = new Request(target.href, nextInit)
    fetchInput = request.url
    fetchInit = toFetchInit(request)
    redirects += 1
  }
}
