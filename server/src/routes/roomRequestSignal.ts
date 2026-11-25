import type { Response } from 'express'
import { ROOM_RUNTIME } from '../config.js'

/** Express's response closes on HTTP cancellation even after reading the body. */
export function roomRequestSignal(response: Response): AbortSignal | undefined {
  if (ROOM_RUNTIME !== 'gateway') return undefined
  const controller = new AbortController()
  response.once('close', () => controller.abort())
  if (response.destroyed) controller.abort()
  return controller.signal
}
