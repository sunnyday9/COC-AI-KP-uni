import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { JWT_SECRET } from '../config.js'

/**
 * API key encryption (AES-256-GCM) — per task brief decision #2.
 * The 32-byte key is derived from JWT_SECRET via sha256, so rotating
 * JWT_SECRET invalidates stored ciphertexts (documented behavior).
 */

/** Encrypted-secret JSON fragment stored inside the settings row. */
export interface EncryptedSecret {
  v: 1
  iv: string // base64
  tag: string // base64
  data: string // base64
}

function deriveKey(): Buffer {
  return createHash('sha256').update(JWT_SECRET).digest()
}

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== 'object' || value === null) return false
  const f = value as Record<string, unknown>
  return (
    f.v === 1 &&
    typeof f.iv === 'string' &&
    typeof f.tag === 'string' &&
    typeof f.data === 'string'
  )
}

/** Encrypt a plaintext secret → EncryptedSecret fragment (caller serializes). */
export function encryptSecret(plain: string): EncryptedSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  }
}

/**
 * Decrypt an EncryptedSecret fragment; returns undefined for non-fragment
 * values or tampered ciphertext (auth tag mismatch).
 */
export function decryptSecret(value: unknown): string | undefined {
  if (!isEncryptedSecret(value)) return undefined
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(),
      Buffer.from(value.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    const dec = Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')),
      decipher.final(),
    ])
    return dec.toString('utf8')
  } catch {
    return undefined
  }
}
