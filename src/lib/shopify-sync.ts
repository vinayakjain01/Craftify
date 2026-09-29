/**
 * @module shopify-sync
 *
 * Full product/variant/image sync from Shopify into Supabase. Fetches every
 * product via the GraphQL Admin client (src/lib/shopify.ts), upserts
 * products/variants/images, reconciles deletions for rows Shopify no longer
 * has, and — when auto-enqueue is on — kicks off creative generation for
 * products that changed and for variants that just came back in stock.
 *
 * RESPONSIBILITIES:
 *   - syncStoreProducts — top-level entry point: loads the store, runs the sync, records a sync_logs row, flags needs_reauth on 401/403
 *
 * DEPENDENCIES: shopify.ts (GraphQL Admin client), generation-queue.ts
 * (enqueueGeneration, findUncoveredInStockVariants — this module auto-enqueues
 * generation for changed/restocked variants), shopify-token.ts (offline token
 * refresh, lazily imported to avoid a require cycle).
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { chunkArray } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { createShopifyClient, ShopifyProduct } from '@/lib/shopify'
import { enqueueGeneration, findUncoveredInStockVariants } from '@/lib/generation-queue'
import { decryptToken, encryptToken } from '@/lib/token-encryption'

type StoreRow = {
  id: string
  shop_domain: string
  access_token: string
  last_synced_at?: string | null
  token_expires_at?: string | null
  refresh_token?: string | null
}

/** Refresh this many ms before expiry, so a long sync can't outlive its token. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * Return a usable access token for the store, refreshing it first if needed.
 *
 * Expiring offline tokens last only 1 hour, and this runs from the cron sync and
 * the worker where no browser session exists to re-trigger token exchange. The
 * stored refresh token is the only way those paths stay authenticated.
 *
 * Best-effort: if the refresh fails we return the existing token and let the
 * real API call produce the authoritative error, rather than masking a working
 * token behind a refresh hiccup.
 */
async function ensureFreshToken(
  store: StoreRow,
  supabase: SupabaseClient
): Promise<string> {
  // stores.access_token/refresh_token are encrypted at rest (see
  // src/lib/token-encryption.ts) — decrypt once here, the single point every
  // sync/worker call funnels through, rather than at each of the two
  // call sites below.
  const accessToken = decryptToken(store.access_token)
  const refreshToken = decryptToken(store.refresh_token)

  const expiresAt = store.token_expires_at ? Date.parse(store.token_expires_at) : null

  // No expiry recorded means a legacy non-expiring token — nothing to refresh,
  // and the Admin API will reject it with a clear message of its own.
  if (!expiresAt || !refreshToken) return accessToken ?? store.access_token
  if (Date.now() < expiresAt - TOKEN_REFRESH_MARGIN_MS) return accessToken ?? store.access_token

  try {
    const { refreshOfflineToken } = await import('@/lib/shopify-token')
    const refreshed = await refreshOfflineToken(store.shop_domain, refreshToken)

    await supabase
      .from('stores')
      .update({
        access_token: encryptToken(refreshed.access_token),
        token_expires_at: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : null,
        // Shopify invalidates the old refresh token immediately, so the new one
        // must land in the same write.
        ...(refreshed.refresh_token ? { refresh_token: encryptToken(refreshed.refresh_token) } : {}),
        ...(refreshed.refresh_token_expires_in
          ? {
              refresh_token_expires_at: new Date(
                Date.now() + refreshed.refresh_token_expires_in * 1000
              ).toISOString(),
            }
          : {}),
        needs_reauth: false,
      })
      .eq('id', store.id)

    console.log(`[sync] refreshed access token for ${store.shop_domain}`)
    return refreshed.access_token
  } catch (err: any) {
    console.error(`[sync] token refresh failed for ${store.shop_domain}:`, err?.message)
    return accessToken ?? store.access_token
  }
}

type SyncOptions = {
  storeId: string
  syncType: 'manual' | 'cron'
  autoEnqueueChanged?: boolean
  incremental?: boolean
  supabase: SupabaseClient
}

type ExistingProduct = {
  id: string
  shopify_id: string
  price: number
  compare_at_price: number | null
  tags: string[] | null
  vendor: string | null
  product_type: string | null
}

const PRODUCT_BATCH_SIZE = 100
const IMAGE_BATCH_SIZE = 100

/**
 * Sync one store's full product/variant/image catalog from Shopify.
 * Records a sync_logs row for the run, updates stores.last_synced_at on
 * success, and flags stores.needs_reauth when the failure looks like an
 * invalid/expired access token (401/403).
 *
 * @param autoEnqueueChanged - when true, auto-enqueues generation for products
 *   that changed this sync and for variants newly back in stock
 * @param incremental - when true, only fetches products updated since the
 *   store's last sync instead of the whole catalog
 * @returns number of products synced
 */
export async function syncStoreProducts({
  storeId,
  syncType,
  autoEnqueueChanged = false,
  incremental = false,
  supabase,
}: SyncOptions): Promise<number> {
  const started = Date.now()
  const { data: store, error: storeError } = await supabase
    .from('stores')
    .select('*')
    .eq('id', storeId)
    .single()

  if (storeError || !store) throw new Error('Store not found')

  const { data: syncLog } = await supabase
    .from('sync_logs')
    .insert({ store_id: storeId, sync_type: syncType, status: 'running' })
    .select()
    .single()

  try {
    const synced = await syncProducts(store as StoreRow, {
      supabase,
      autoEnqueueChanged,
      incremental,
    })

    await supabase
      .from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', storeId)

    await supabase
      .from('sync_logs')
      .update({
        status: 'completed',
        products_synced: synced,
        completed_at: new Date().toISOString(),
      })
      .eq('id', syncLog?.id)

    logPerf('shopify.sync.total', Date.now() - started, {
      storeId,
      syncType,
      products: synced,
    })

    return synced
  } catch (err: any) {
    // A 403/401 means the stored token is invalid/expired (Shopify's
    // non-expiring-token deprecation). Flag the store so the UI prompts a
    // reconnect instead of silently failing every sync.
    const msg = String(err?.message || '')
    const isAuthError = msg.includes('403') || msg.includes('401') ||
      msg.toLowerCase().includes('access token')
    if (isAuthError) {
      await supabase
        .from('stores')
        .update({ needs_reauth: true })
        .eq('id', storeId)
    }

    await supabase
      .from('sync_logs')
      .update({
        status: 'failed',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', syncLog?.id)
    throw err
  }
}

async function syncProducts(
  store: StoreRow,
  {
    supabase,
    autoEnqueueChanged,
    incremental,
  }: {
    supabase: SupabaseClient
    autoEnqueueChanged: boolean
    incremental: boolean
  }
) {
  const accessToken = await ensureFreshToken(store, supabase)
  const shopify = createShopifyClient(store.shop_domain, accessToken)
  const shopifyProducts = await measureAsync(
    'shopify.products.fetch_all',
    () => shopify.getProducts({
      updatedAtMin: incremental ? store.last_synced_at || undefined : undefined,
    }),
    { storeId: store.id, incremental }
  )

  console.log('Products fetched:', shopifyProducts.length, 'Store:', store.shop_domain)
  if (shopifyProducts.length === 0) return 0

  const existingByShopifyId = await loadExistingProducts(
    supabase,
    store.id,
    shopifyProducts.map(product => product.id.toString())
  )

  const productRows = shopifyProducts.map(sp => toProductRow(store.id, sp))
  const productIdByShopifyId = new Map<string, string>()
  const changedProductIds: string[] = []

  for (const batch of chunkArray(productRows, PRODUCT_BATCH_SIZE)) {
    const { data, error } = await measureAsync(
      'supabase.products.batch_upsert',
      () => supabase
        .from('products')
        .upsert(batch, { onConflict: 'store_id,shopify_id' })
        .select('id, shopify_id'),
      { rows: batch.length, storeId: store.id }
    )
    if (error) throw new Error(error.message)

    for (const product of data || []) {
      productIdByShopifyId.set((product as any).shopify_id, (product as any).id)
    }
  }

  // Snapshot variant state BEFORE it is overwritten below — this is the only
  // window in which the previous prices/stock are still readable.
  const existingVariantPrints = await loadExistingVariantPrints(
    supabase,
    Array.from(productIdByShopifyId.values())
  )

  for (const row of productRows) {
    const productId = productIdByShopifyId.get(row.shopify_id)
    if (!productId) continue

    const existing = existingByShopifyId.get(row.shopify_id)
    const shopifyProduct = shopifyProducts.find(sp => sp.id.toString() === row.shopify_id)

    // Product-level fields, OR anything about the variant set. Checking only the
    // product row would miss a price change on the second variant, because
    // products.price mirrors variant[0] alone.
    const variantsChanged =
      existingVariantPrints.get(productId) !== variantFingerprint(shopifyProduct)

    if (!existing || productChanged(existing, row) || variantsChanged) {
      changedProductIds.push(productId)
    }
  }

  // Variants before images: image rows carry variant_ids, and a variant that
  // does not exist yet would make that association point at nothing.
  await replaceProductVariants(supabase, store.id, productIdByShopifyId, shopifyProducts)
  await replaceProductImages(supabase, productIdByShopifyId, shopifyProducts)

  if (autoEnqueueChanged && changedProductIds.length > 0) {
    try {
      await enqueueGeneration({ storeId: store.id, productIds: changedProductIds }, supabase)
    } catch (err) {
      console.error('auto-enqueue failed:', err)
    }
  }

  // In-Stock Only: catches restocks that changedProductIds' fingerprint diff
  // misses — a product sold out since before this feature existed (never had
  // a creative, hasn't "changed" since) — as a backstop alongside the
  // change-driven enqueue above.
  if (autoEnqueueChanged) {
    await autoGenerateRestockedVariants(store.id, supabase)
  }

  return productRows.length
}

/** Cap per sync cycle — avoids flooding the queue on a big restock event. */
const RESTOCK_ENQUEUE_LIMIT = 500

/**
 * Find in-stock variants with no generated creative AND no generation job
 * already in flight for them, then queue generation so they reach the feed as
 * soon as possible.
 */
async function autoGenerateRestockedVariants(
  storeId: string,
  supabase: SupabaseClient
): Promise<void> {
  let uncovered: Array<{ id: string; product_id: string }>
  try {
    uncovered = await findUncoveredInStockVariants(storeId, supabase)
  } catch (err: any) {
    console.error('[sync] restock check failed:', err.message)
    return
  }
  if (uncovered.length === 0) return

  // Exclude variants with a job already pending/processing — without this, a
  // restock queued today but not yet drained gets queued AGAIN by tomorrow's
  // sync, since it still has no generated_creatives row until the first job
  // actually completes.
  const { data: inFlight, error: inFlightError } = await supabase
    .from('generation_jobs')
    .select('variant_id')
    .eq('store_id', storeId)
    .in('status', ['pending', 'processing'])
    .not('variant_id', 'is', null)

  if (inFlightError) {
    console.error('[sync] restock check: in-flight job lookup failed:', inFlightError.message)
    return
  }

  const inFlightIds = new Set((inFlight ?? []).map((j: any) => j.variant_id))
  const stillUncovered = uncovered.filter(v => !inFlightIds.has(v.id))
  if (stillUncovered.length === 0) return

  const capped = stillUncovered.slice(0, RESTOCK_ENQUEUE_LIMIT)
  const productIds = [...new Set(capped.map(v => v.product_id))]

  console.log(
    `[sync] ${stillUncovered.length} in-stock variant(s) with no creative — ` +
    `queuing ${capped.length} across ${productIds.length} product(s)` +
    (stillUncovered.length > capped.length
      ? ` (${stillUncovered.length - capped.length} more will be picked up next sync)`
      : '')
  )

  try {
    await enqueueGeneration(
      {
        storeId,
        productIds,
        batchId: `restock-${randomUUID()}`,
        imageScope: 'first',   // first pose only on auto-restock
        basePriority: 200,     // lower than user-triggered generates
      },
      supabase
    )
  } catch (err: any) {
    // Non-fatal — sync must not fail because generation is temporarily unavailable.
    console.error('[sync] restock generation enqueue failed:', err.message)
  }
}

async function loadExistingProducts(
  supabase: SupabaseClient,
  storeId: string,
  shopifyIds: string[]
) {
  const existingByShopifyId = new Map<string, ExistingProduct>()

  for (const ids of chunkArray(shopifyIds, 1000)) {
    const { data, error } = await measureAsync(
      'supabase.products.existing_lookup',
      () => supabase
        .from('products')
        .select('id, shopify_id, price, compare_at_price, tags, vendor, product_type')
        .eq('store_id', storeId)
        .in('shopify_id', ids),
      { rows: ids.length, storeId }
    )
    if (error) throw new Error(error.message)
    for (const row of data || []) {
      existingByShopifyId.set((row as ExistingProduct).shopify_id, row as ExistingProduct)
    }
  }

  return existingByShopifyId
}

function toProductRow(storeId: string, sp: ShopifyProduct) {
  const primaryVariant = sp.variants[0]
  const price = primaryVariant ? parseFloat(primaryVariant.price) : 0
  const compareAtPrice = primaryVariant?.compare_at_price
    ? parseFloat(primaryVariant.compare_at_price)
    : null
  const tags = sp.tags
    ? sp.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
    : []

  return {
    store_id: storeId,
    shopify_id: sp.id.toString(),
    title: sp.title,
    handle: sp.handle,
    vendor: sp.vendor || null,
    product_type: sp.product_type || null,
    tags,
    description: sp.description || null,
    status: sp.status,
    // DEPRECATED variant[0] mirror. The authoritative values now live in
    // product_variants; these columns stay populated only so the pages and
    // rules that still read products.price keep working until they migrate.
    price,
    compare_at_price: compareAtPrice,
    inventory_quantity: primaryVariant?.inventory_quantity || 0,
    // products.sku is deliberately NOT written. A leftover UNIQUE(store_id, sku)
    // constraint from the removed folder-import flow (where filename doubled as
    // the dedup key) makes it fatal here: real catalogs reuse a SKU across
    // products, so syncing 741 products died on
    //   duplicate key value violates unique constraint "products_store_id_sku_key"
    // In v2 the SKU belongs to the variant, which is uniquely keyed on
    // (store_id, shopify_variant_id). Migration 006 drops the stale constraint.
    //
    // Option NAMES (as opposed to option1/2/3's values, already on
    // product_variants) — lets "Generate creatives" filter by e.g. Size: M
    // instead of an unlabelled position. Null for stores synced before
    // migration 008; the generation-queue falls back to checking every
    // position's value in that case.
    option1_name: sp.option_names[0] || null,
    option2_name: sp.option_names[1] || null,
    option3_name: sp.option_names[2] || null,
    updated_at: new Date().toISOString(),
  }
}

function toVariantRows(storeId: string, productId: string, sp: ShopifyProduct) {
  return sp.variants.map(v => ({
    product_id: productId,
    store_id: storeId,
    shopify_variant_id: v.id.toString(),
    title: v.title || null,
    sku: v.sku,
    barcode: v.barcode,
    price: v.price ? parseFloat(v.price) : 0,
    compare_at_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
    inventory_quantity: v.inventory_quantity,
    inventory_policy: v.inventory_policy,
    option1: v.option1,
    option2: v.option2,
    option3: v.option3,
    position: v.position,
    weight: v.weight,
    weight_unit: v.weight_unit,
    updated_at: new Date().toISOString(),
    // is_sold_out is a generated column — never written here.
  }))
}

/**
 * Upsert every variant, then remove the ones Shopify no longer has.
 *
 * Deletes are scoped to the products in THIS sync batch, so an incremental sync
 * (which only fetches recently-updated products) cannot wipe the variants of
 * products it never looked at.
 */
async function replaceProductVariants(
  supabase: SupabaseClient,
  storeId: string,
  productIdByShopifyId: Map<string, string>,
  shopifyProducts: ShopifyProduct[]
) {
  const variantRows: ReturnType<typeof toVariantRows> = []
  const seenByProductId = new Map<string, string[]>()

  for (const sp of shopifyProducts) {
    const productId = productIdByShopifyId.get(sp.id.toString())
    if (!productId) continue

    const rows = toVariantRows(storeId, productId, sp)
    variantRows.push(...rows)
    seenByProductId.set(productId, rows.map(r => r.shopify_variant_id))
  }

  for (const batch of chunkArray(variantRows, PRODUCT_BATCH_SIZE)) {
    const { error } = await measureAsync(
      'supabase.product_variants.batch_upsert',
      () => supabase
        .from('product_variants')
        .upsert(batch, { onConflict: 'store_id,shopify_variant_id' }),
      { rows: batch.length, storeId }
    )
    if (error) throw new Error(error.message)
  }

  // Reconcile deletions — a variant removed in Shopify must stop appearing in
  // the products list and the feed. Upserting alone would leave it orphaned.
  //
  // Done as one read plus one delete of just the stale ids. The obvious version
  // — a scoped DELETE per product — is O(products) sequential round-trips: on
  // this catalog that was 741 of them, which exhausted the function's time
  // budget before image syncing ever ran, leaving product_images empty and
  // last_synced_at unset. Deleting by id also avoids a `not.in` list carrying
  // ~9.5k variant ids in a URL.
  const productIds = Array.from(seenByProductId.keys())
  const staleIds: string[] = []

  for (const chunk of chunkArray(productIds, 200)) {
    // Paginated within the chunk, not just one call: Supabase caps rows
    // returned per request (project default 1,000) regardless of how the
    // `.in()` list was chunked, and a 200-product chunk can easily carry more
    // variant rows than that on a catalog with 10+ variants/product. An
    // unpaginated read here would silently see only part of "existing" and
    // under-reconcile — some genuinely stale variants just never get deleted.
    for (let from = 0; ; from += 1000) {
      const { data: existing, error } = await measureAsync(
        'supabase.product_variants.reconcile_lookup',
        () => supabase
          .from('product_variants')
          .select('id, product_id, shopify_variant_id')
          .in('product_id', chunk)
          .order('id', { ascending: true })
          .range(from, from + 1000 - 1),
        { rows: chunk.length, storeId }
      )
      if (error) throw new Error(error.message)

      for (const row of existing ?? []) {
        const keep = seenByProductId.get((row as any).product_id)
        if (keep && !keep.includes(String((row as any).shopify_variant_id))) {
          staleIds.push((row as any).id)
        }
      }

      if (!existing || existing.length < 1000) break
    }
  }

  for (const chunk of chunkArray(staleIds, 200)) {
    const { error } = await supabase.from('product_variants').delete().in('id', chunk)
    if (error) throw new Error(error.message)
  }

  if (staleIds.length > 0) {
    console.log(`[sync] removed ${staleIds.length} variants no longer in Shopify`)
  }
}

function productChanged(existing: ExistingProduct, next: ReturnType<typeof toProductRow>) {
  return fingerprint(existing) !== fingerprint(next)
}

/**
 * Stable signature of a product's variant set — the fields whose change should
 * force a creative to be regenerated (price, sale price, stock, availability).
 * Sorted by variant id so Shopify's ordering can't produce a false positive.
 */
function variantFingerprint(sp: ShopifyProduct | undefined): string {
  if (!sp) return ''
  return JSON.stringify(
    sp.variants
      .map(v => [
        v.id.toString(),
        Number(v.price ?? 0),
        v.compare_at_price == null ? null : Number(v.compare_at_price),
        v.inventory_quantity,
        v.inventory_policy,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  )
}

/** Per-product variant fingerprints as currently stored. */
async function loadExistingVariantPrints(
  supabase: SupabaseClient,
  productIds: string[]
): Promise<Map<string, string>> {
  const byProduct = new Map<string, any[]>()

  for (const ids of chunkArray(productIds, 500)) {
    // Paginated within the chunk: product_variants returns many rows per
    // product_id, so 500 products can carry well over Supabase's per-request
    // row cap (default 1,000). An unpaginated read here silently drops some
    // products from the map entirely, and a missing entry compares as
    // "changed" below — not incorrect, but it re-enqueues generation for
    // products that may not have actually changed.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await measureAsync(
        'supabase.product_variants.existing_lookup',
        () => supabase
          .from('product_variants')
          .select('id, product_id, shopify_variant_id, price, compare_at_price, inventory_quantity, inventory_policy')
          .in('product_id', ids)
          .order('product_id', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + 1000 - 1),
        { rows: ids.length }
      )
      // A missing table (migration 002 not applied yet) must not break syncing —
      // change detection just falls back to the product-level comparison.
      if (error) {
        console.warn('[sync] variant fingerprint lookup skipped:', error.message)
        return new Map()
      }
      for (const row of data || []) {
        const list = byProduct.get((row as any).product_id) ?? []
        list.push(row)
        byProduct.set((row as any).product_id, list)
      }
      if (!data || data.length < 1000) break
    }
  }

  const prints = new Map<string, string>()
  for (const [productId, rows] of byProduct) {
    prints.set(
      productId,
      JSON.stringify(
        rows
          .map(r => [
            String(r.shopify_variant_id),
            Number(r.price ?? 0),
            r.compare_at_price == null ? null : Number(r.compare_at_price),
            r.inventory_quantity,
            r.inventory_policy,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      )
    )
  }
  return prints
}

function fingerprint(value: {
  price: number
  compare_at_price: number | null
  tags: string[] | null
  vendor: string | null
  product_type: string | null
}) {
  return JSON.stringify([
    value.price,
    value.compare_at_price,
    [...(value.tags || [])].sort(),
    value.vendor,
    value.product_type,
  ])
}

async function replaceProductImages(
  supabase: SupabaseClient,
  productIdByShopifyId: Map<string, string>,
  shopifyProducts: ShopifyProduct[]
) {
  const imageRows = []
  const productIdsWithImages: string[] = []

  for (const sp of shopifyProducts) {
    const productId = productIdByShopifyId.get(sp.id.toString())
    if (!productId || !sp.images?.length) continue

    productIdsWithImages.push(productId)
    for (const [idx, img] of sp.images.entries()) {
      imageRows.push({
        product_id: productId,
        shopify_image_id: img.id.toString(),
        src: img.src,
        alt: img.alt || null,
        position: img.position || idx,
        is_primary: idx === 0,
        width: img.width,
        height: img.height,
        // Which variants display this image — drives the per-variant gallery.
        variant_ids: img.variant_ids,
      })
    }
  }

  for (const productIds of chunkArray(productIdsWithImages, IMAGE_BATCH_SIZE)) {
    const { error } = await measureAsync(
      'supabase.product_images.batch_delete',
      () => supabase.from('product_images').delete().in('product_id', productIds),
      { rows: productIds.length }
    )
    if (error) throw new Error(error.message)
  }

  for (const batch of chunkArray(imageRows, 1000)) {
    const { error } = await measureAsync(
      'supabase.product_images.batch_insert',
      () => supabase.from('product_images').insert(batch),
      { rows: batch.length }
    )
    if (error) throw new Error(error.message)
  }
}