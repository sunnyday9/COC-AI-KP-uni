/**
 * Typed error classes so routes can map failures to HTTP status codes while
 * keeping the unified `{ error: string }` response shape (api-contract 约定).
 */
import type { Response } from 'express'
import { logger } from './logging.js'

/** Validation / configuration error → HTTP 400. */
export class BadRequestError extends Error {}

/** Conflict (e.g. duplicate username) → HTTP 409. */
export class ConflictError extends Error {}

/** Authentication failure → HTTP 401. */
export class UnauthorizedError extends Error {}

/** Upstream (AI provider) failure → HTTP 502. */
export class UpstreamError extends Error {}

/** Error message extraction without leaking stack traces. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Map a thrown error to the unified `{ error: string }` response.
 * Unknown errors are logged and returned as a generic 500 (no stack traces).
 */
export function sendError(res: Response, err: unknown): void {
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message })
    return
  }
  if (err instanceof UnauthorizedError) {
    res.status(401).json({ error: err.message })
    return
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message })
    return
  }
  if (err instanceof UpstreamError) {
    res.status(502).json({ error: err.message })
    return
  }
  logger.error('unhandled route error', { error: errorMessage(err) })
  res.status(500).json({ error: 'internal server error' })
}
