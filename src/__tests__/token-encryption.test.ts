/**
 * encryptToken()/decryptToken() (src/lib/token-encryption.ts) are the only
 * thing standing between a plaintext Shopify access token and the database —
 * these guard the round trip, the legacy-plaintext passthrough that lets
 * existing tokens keep working post-deploy, and the wrong-key failure mode.
 */
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64) // 32 bytes of 0xaa — valid test key

import { encryptToken, decryptToken } from '@/lib/token-encryption'

// Deliberately NOT shaped like a real Shopify token (no shpat_/shpca_/shpss_
// prefix followed by hex) — GitHub's push protection secret scanner flags
// that pattern as a live credential even inside a test fixture string.
const FAKE_TOKEN_1 = 'test-fixture-token-value-one'
const FAKE_TOKEN_2 = 'test-fixture-token-value-two'

describe('token-encryption', () => {
  it('round-trips a token through encrypt then decrypt', () => {
    const encrypted = encryptToken(FAKE_TOKEN_1)
    expect(encrypted).not.toBeNull()
    expect(encrypted).not.toBe(FAKE_TOKEN_1)
    expect(decryptToken(encrypted)).toBe(FAKE_TOKEN_1)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const first = encryptToken(FAKE_TOKEN_1)
    const second = encryptToken(FAKE_TOKEN_1)
    expect(first).not.toBe(second)
    expect(decryptToken(first)).toBe(FAKE_TOKEN_1)
    expect(decryptToken(second)).toBe(FAKE_TOKEN_1)
  })

  it('passes a legacy plaintext token through unchanged', () => {
    expect(decryptToken(FAKE_TOKEN_2)).toBe(FAKE_TOKEN_2)
  })

  it('returns null for null/undefined input on both directions', () => {
    expect(encryptToken(null)).toBeNull()
    expect(encryptToken(undefined)).toBeNull()
    expect(decryptToken(null)).toBeNull()
    expect(decryptToken(undefined)).toBeNull()
  })

  it('returns null (not a throw) when decrypting with the wrong key', () => {
    const encrypted = encryptToken(FAKE_TOKEN_1)!
    process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64) // different key
    expect(() => decryptToken(encrypted)).not.toThrow()
    expect(decryptToken(encrypted)).toBeNull()
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64) // restore for other tests
  })
})
