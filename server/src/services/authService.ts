import bcrypt from 'bcryptjs'
import { getDb } from '../db/index.js'
import { signToken } from '../middleware/auth.js'
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

/**
 * Auth service — register / login / me (api-contract §1).
 * bcrypt cost 10; JWT 30 days (issued by signToken).
 */

export interface AuthUser {
  id: number
  username: string
}

export interface AuthResult {
  token: string
  user: AuthUser
}

const BCRYPT_COST = 10
const USERNAME_MIN = 3
const USERNAME_MAX = 32
const PASSWORD_MIN = 6

interface UserRow {
  id: number
  username: string
  password_hash: string
}

function findUserByUsername(username: string): UserRow | undefined {
  const row = getDb()
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as UserRow | undefined
  return row
}

function findUserById(id: number): AuthUser | undefined {
  const row = getDb()
    .prepare('SELECT id, username FROM users WHERE id = ?')
    .get(id) as AuthUser | undefined
  return row
}

export function validateCredentials(username: unknown, password: unknown): void {
  if (typeof username !== 'string' || username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    throw new BadRequestError(`username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`)
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new BadRequestError(`password must be at least ${PASSWORD_MIN} characters`)
  }
}

/** Register a new user; returns token + user. ConflictError(409) on duplicate. */
export async function register(username: unknown, password: unknown): Promise<AuthResult> {
  validateCredentials(username, password)
  const name = username as string
  if (findUserByUsername(name)) {
    throw new ConflictError('username already taken')
  }
  const passwordHash = await bcrypt.hash(password as string, BCRYPT_COST)
  const createdAt = Date.now()
  const info = getDb()
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(name, passwordHash, createdAt)
  const userId = Number(info.lastInsertRowid)
  logger.info('user registered', { userId, username: name })
  return { token: signToken(userId), user: { id: userId, username: name } }
}

/** Login; returns token + user. UnauthorizedError(401) on unknown user / wrong password. */
export async function login(username: unknown, password: unknown): Promise<AuthResult> {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new BadRequestError('username and password are required')
  }
  const user = findUserByUsername(username)
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false
  if (!user || !ok) {
    throw new UnauthorizedError('invalid username or password')
  }
  logger.info('user logged in', { userId: user.id, username: user.username })
  return { token: signToken(user.id), user: { id: user.id, username: user.username } }
}

/** Resolve a user by id for GET /api/auth/me; undefined when deleted. */
export function getUserById(userId: number): AuthUser | undefined {
  return findUserById(userId)
}
