/**
 * POST /api/webhooks/app/uninstalled
 *
 * Fires as soon as a merchant uninstalls Craftify — well before shop/redact,
 * which Shopify doesn't send until 48 hours later. Used to freeze the store
 * immediately (stop syncing, stop generating, revoke the now-invalid token)
 * rather than let background jobs keep running against a shop that removed
 * the app, purely because full data deletion hasn't fired yet.
 *
 * This does NOT delete data — that stays shop/redact's job, on Shopify's own
 * schedule. This only stops touching the store.
 *
 * Auth:     HMAC signature verification via verifyShopifyWebhook() against the
 *           raw request body and the X-Shopify-Hmac-Sha256 header (no session/bearer auth)
 * Body:     Shopify's app/uninstalled payload — the shop domain arrives as
 *           `myshopify_domain` (falls back to `domain` for older payload shapes)
 * Returns:  200 "OK" on success; 401 "Unauthorized" if the HMAC check fails;
 *           400 "Bad payload" if the body isn't valid JSON
 *
 * Flow: read raw body -> verify HMAC -> parse shop domain -> mark the store
 * inactive, clear its tokens, cancel pending generation jobs -> respond 200
 */
import { NextRequest, NextResponse } from 'next/server'
import { verifyShopifyWebhook } from '@/lib/shopify-webhook'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let shopDomain: string | undefined
  try {
    const payload = JSON.parse(rawBody)
    shopDomain = payload?.myshopify_domain ?? payload?.domain
  } catch {
    return new NextResponse('Bad payload', { status: 400 })
  }

  if (shopDomain) {
    const admin = createSupabaseAdmin(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: store } = await admin
      .from('stores')
      .select('id')
      .eq('shop_domain', shopDomain)
      .maybeSingle()

    if (store) {
      // Freeze the store: /api/cron/sync only selects is_active=true stores,
      // so this alone stops future syncs. Deleting pending jobs below is
      // what actually stops generation — the worker doesn't gate on
      // is_active. The token is revoked on Shopify's side the moment the
      // merchant uninstalls anyway — nulling it here just makes sure this
      // app never tries to use a token it knows is dead.
      await admin
        .from('stores')
        .update({
          is_active: false,
          needs_reauth: true,
          access_token: null,
          refresh_token: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', store.id)

      // Cancel work that hasn't started yet — no point generating creatives
      // for a store that no longer has the app installed.
      await admin
        .from('generation_jobs')
        .delete()
        .eq('store_id', store.id)
        .eq('status', 'pending')
    }
  }

  return new NextResponse('OK', { status: 200 })
}
