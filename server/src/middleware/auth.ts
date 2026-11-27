import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { DEPLOYMENT_MODE, JWT_SECRET } from '../config.js'

/** Express request augmented with the authenticated user id. */
export interface AuthRequest extends Request {
  userId?: number
}

const TOKEN_TTL = '30d'
const TOKEN_ISSUER = DEPLOYMENT_MODE === 'shared-accounts' ? 'aikp-shared-accounts' : undefined

/** Issue a JWT for the given user id (30-day validity, per api-contract §1). */
export function signToken(userId: number): string {
  const claims = TOKEN_ISSUER ? { sub: String(userId), iss: TOKEN_ISSUER } : { sub: String(userId) }
  return jwt.sign(claims, JWT_SECRET, { expiresIn: TOKEN_TTL })
}

/** Verify a JWT; returns the user id or null when invalid/expired. */
export function verifyToken(token: string): { userId: number } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload
    if (payload.iss !== TOKEN_ISSUER) return null
    const sub = payload.sub
    if (typeof sub !== 'string') return null
    const userId = Number(sub)
    return Number.isSafeInteger(userId) && userId > 0 ? { userId } : null
  } catch {
    return null
  }
}

/**
 * Express middleware: requires `Authorization: Bearer <JWT>`.
 * On success injects `req.userId`; otherwise responds 401.
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing or invalid authorization header' })
    return
  }
  const token = header.slice('Bearer '.length).trim()
  const result = verifyToken(token)
  if (!result) {
    res.status(401).json({ error: 'invalid or expired token' })
    return
  }
  req.userId = result.userId
  next()
}
