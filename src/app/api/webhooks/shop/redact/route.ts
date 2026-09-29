/**
 * POST /api/webhooks/shop/redact
 *
 * Shopify's mandatory GDPR webhook: fired 48 hours after a shop uninstalls the
 * app, asking it to erase that shop's data.
 *
 * Auth:     HMAC signature verification via verifyShopifyWebhook() against the
 *           raw request body and the X-Shopify-Hmac-Sha256 header (no session/bearer auth)
 * Body:     Shopify's shop/redact payload — `shop_domain` is read from the raw JSON body
 * Returns:  200 "OK" on success; 401 "Unauthorized" if the HMAC check fails;
 *           400 "Bad payload" if the body isn't valid JSON
 *
 * Flow: read raw body -> verify HMAC -> parse shop_domain -> look up the
 * store -> delete its Cloudinary creatives BY EXACT public_id -> delete its
 * rows from cache tables that don't cascade from stores -> delete the store
 * row (cascades to products/variants/images/templates/rules/generation_jobs/
 * generated_creatives via their store_id foreign keys) -> respond 200.
 *
 * CLOUDINARY DELETION IS BY EXACT ID, NEVER BY FOLDER PREFIX. Every
 * placement's folder (catalog-creatives/catalog, /feed, /story, /reel) is
 * shared across every store in this Cloudinary account — public_id, not the
 * folder, is what's store-specific. Deleting a store's row's own
 * generated_creatives.cloudinary_id values is safe; deleting everything
 * under a shared folder prefix would erase every other tenant's creatives
 * too. See deleteImages()'s own doc comment in src/lib/cloudinary.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { verifyShopifyWebhook } from '@/lib/shopify-webhook'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { deleteImages } from '@/lib/cloudinary'

export const runtime = 'nodejs'

// Tables keyed by store_id that do NOT have a foreign key cascading from
// stores (they're derived caches, added at different points in this app's
// history) — deleted explicitly so shop/redact actually erases them instead
// of leaving orphaned rows once the store row itself is gone.
const STORE_SCOPED_TABLES_WITHOUT_CASCADE = [
  'bg_removal_cache',
  'image_extend_cache',
  'background_reconstruction_cache',
  'sync_logs',
] as const

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let shopDomain: string | undefined
  try {
    shopDomain = JSON.parse(rawBody)?.shop_domain
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
      const storeId = store.id

      // Delete this store's Cloudinary creatives by their exact public_id —
      // paginated, since a large catalog can have thousands of rows.
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data: creatives, error } = await admin
          .from('generated_creatives')
          .select('cloudinary_id')
          .eq('store_id', storeId)
          .not('cloudinary_id', 'is', null)
          .range(from, from + PAGE - 1)
        if (error || !creatives || creatives.length === 0) break

        const ids = creatives.map(c => c.cloudinary_id).filter(Boolean) as string[]
        if (ids.length > 0) await deleteImages(ids)
        if (creatives.length < PAGE) break
      }

      // Cache tables with no FK cascade from stores.
      for (const table of STORE_SCOPED_TABLES_WITHOUT_CASCADE) {
        await admin.from(table).delete().eq('store_id', storeId).then(
          () => {},
          err => console.error(`[shop/redact] ${table} cleanup failed:`, err)
        )
      }

      // Deleting the store cascades to products, variants, images, templates,
      // rules, generation_jobs, and generated_creatives via their store_id
      // foreign keys.
      await admin.from('stores').delete().eq('id', storeId)
    }
  }

  return new NextResponse('OK', { status: 200 })
}