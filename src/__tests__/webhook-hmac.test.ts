/**
 * verifyShopifyWebhook() (src/lib/shopify-webhook.ts) is the entire auth
 * check on every /api/webhooks/* route — GDPR redact, app/uninstalled. A
 * bypassable or over-strict check here means either forged webhooks get
 * acted on, or Shopify's own real ones get rejected.
 */
process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret-for-hmac'

import crypto from 'crypto'
import { verifyShopifyWebhook } from '@/lib/shopify-webhook'

/** Computes the header a real Shopify webhook request would carry for `body`. */
function signBody(body: string, secret = process.env.SHOPIFY_CLIENT_SECRET!): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64')
}

describe('verifyShopifyWebhook', () => {
  it('accepts a correctly-signed body', () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' })
    expect(verifyShopifyWebhook(body, signBody(body))).toBe(true)
  })

  it('rejects a body that was tampered with after signing', () => {
    const original = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' })
    const signature = signBody(original)
    const tampered = JSON.stringify({ shop_domain: 'attacker-shop.myshopify.com' })
    expect(verifyShopifyWebhook(tampered, signature)).toBe(false)
  })

  it('rejects a signature computed with the wrong secret', () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' })
    expect(verifyShopifyWebhook(body, signBody(body, 'wrong-secret'))).toBe(false)
  })

  it('rejects a missing signature header', () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' })
    expect(verifyShopifyWebhook(body, null)).toBe(false)
  })

  it('rejects when SHOPIFY_CLIENT_SECRET is not configured', () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' })
    const signature = signBody(body)
    const saved = process.env.SHOPIFY_CLIENT_SECRET
    delete process.env.SHOPIFY_CLIENT_SECRET
    expect(verifyShopifyWebhook(body, signature)).toBe(false)
    process.env.SHOPIFY_CLIENT_SECRET = saved
  })

  it('does not throw on a signature of a different length than expected', () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' })
    expect(() => verifyShopifyWebhook(body, 'short')).not.toThrow()
    expect(verifyShopifyWebhook(body, 'short')).toBe(false)
  })
})
