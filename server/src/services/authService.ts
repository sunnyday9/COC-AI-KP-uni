import bcrypt from 'bcryptjs'
import { DEPLOYMENT_MODE } from '../config.js'
import { accounts, type Account } from './accountStorage.js'
import { signToken } from '../middleware/auth.js'
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/errors.js'
import { logger } from '../utils/logging.js'

/**
 * Auth service — register / login / me (api-contract §1).
 * bcrypt cost 10; JWT 30 days (issued by signToken).
 */

export interface AuthResult {
  token: string
  user: Account
}

const BCRYPT_COST = 10
const USERNAME_MIN = 3
const USERNAME_MAX = 32
const PASSWORD_MIN = 6

function validateSharedUsername(username: string): void {
  if (DEPLOYMENT_MODE === 'shared-accounts' && username.includes('\u0000')) {
    throw new BadRequestError('username must not contain a null character')
  }
}

export function validateCredentials(username: unknown, password: unknown): void {
  if (typeof username !== 'string' || username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    throw new BadRequestError(`username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`)
  }
  validateSharedUsername(username)
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new BadRequestError(`password must be at least ${PASSWORD_MIN} characters`)
  }
}

/** Register a new user; returns token + user. ConflictError(409) on duplicate. */
export async function register(username: unknown, password: unknown): Promise<AuthResult> {
  validateCredentials(username, password)
  const name = username as string
  const passwordHash = await bcrypt.hash(password as string, BCRYPT_COST)
  const userId = await accounts.create(name, passwordHash)
  if (userId === undefined) throw new ConflictError('username already taken')
  logger.info('user registered', { userId, username: name })
  return { token: signToken(userId), user: { id: userId, username: name } }
}

/** Login; returns token + user. UnauthorizedError(401) on unknown user / wrong password. */
export async function login(username: unknown, password: unknown): Promise<AuthResult> {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new BadRequestError('username and password are required')
  }
  validateSharedUsername(username)
  const user = await accounts.findByUsername(username)
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false
  if (!user || !ok) {
    throw new UnauthorizedError('invalid username or password')
  }
  logger.info('user logged in', { userId: user.id, username: user.username })
  return { token: signToken(user.id), user: { id: user.id, username: user.username } }
}

/** Resolve a user by id for GET /api/auth/me; undefined when deleted. */
export function getUserById(userId: number): Promise<Account | undefined> {
  return accounts.findById(userId)
}
