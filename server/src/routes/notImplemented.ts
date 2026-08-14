import type { Request, Response } from 'express'

/** Unified placeholder response for not-yet-implemented business routes. */
export function notImplemented(_req: Request, res: Response): void {
  res.status(501).json({ error: 'not implemented' })
}
