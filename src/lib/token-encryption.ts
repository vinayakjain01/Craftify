/**
 * @module token-encryption
 *
 * AES-256-GCM encryption for Shopify access/refresh tokens at rest.
 *
 * Tokens are encrypted immediately before being written to `stores` and
 * decrypted only where they're actually used to call Shopify's API —
 * currently that's a single point, ensureFreshToken() in shopify-sync.ts.
 * They are never logged or returned to a client.
 *
 * RESPONSIBILITIES:
 *   - encryptToken — AES-256-GCM encrypt a token for storage
 *   - decryptToken — reverse encryptToken(); passes legacy plaintext tokens through unchanged
 *
 * KEY: TOKEN_ENCRYPTION_KEY env var — 64-char hex string (32 bytes).
 *      Generate once with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *      Set in Vercel env vars. Rotating it invalidates every token encrypted
 *      under the old key — decryptToken() returns null for those, which
 *      needs_reauth-style handling downstream treats as "must reconnect."
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12   // 96 bits — GCM standard
const KEY_HEX_LENGTH = 64 // 32 bytes

function getKey(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY
  if (!hex || hex.length !== KEY_HEX_LENGTH) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Encrypts a token string.
 * Output format: hex(iv):hex(authTag):hex(ciphertext)
 * Returns null unchanged (no token to encrypt) — never encrypts an absent value.
 */
export function encryptToken(token: string | null | undefined): string | null {
  if (!token) return null
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypts a token encrypted by encryptToken().
 *
 * Legacy plaintext tokens (stored before this module existed, no ':'
 * separator) pass through unchanged — this lets existing stores keep working
 * immediately after deploy, with no backfill migration or flag day. Every
 * token naturally re-encrypts itself the next time shopify-sync.ts's
 * ensureFreshToken() refreshes it.
 */
export function decryptToken(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null

  const parts = encrypted.split(':')
  if (parts.length !== 3) return encrypted // legacy plaintext

  try {
    const [ivHex, tagHex, dataHex] = parts
    const key = getKey()
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return decipher.update(Buffer.from(dataHex, 'hex')).toString('utf8') +
      decipher.final('utf8')
  } catch {
    // Corrupted value or wrong key — null triggers the existing needs_reauth
    // path in callers rather than silently using a garbage token.
    console.error('[token-encryption] decryption failed')
    return null
  }
}
