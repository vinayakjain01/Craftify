/**
 * @module generation-queue
 *
 * The creative-generation job pipeline: computes which (variant, image) pairs
 * need a creative, enqueues one job per pair, and processes those jobs end to
 * end (template resolution -> AI product-layer bundle -> composite -> Cloudinary
 * upload -> generated_creatives record). Used by /api/generate/enqueue (bulk
 * submit), /api/generate/estimate (dry-run count — reuses computeGenerationRows
 * so the preview never drifts from the real enqueue), /api/cron/generate
 * (DB-poll drain), and src/workers/catalog-worker.ts (BullMQ path).
 *
 * Fan-out is per in-stock VARIANT (sold-out variants are filtered out before
 * fan-out — see the In-Stock Only comments below) times per IMAGE depending on
 * imageScope ('first' or 'all') times per placement ASSET TYPE ('catalog' by
 * default; opt into 'feed'/'story'/'reel' via assetTypes). Only 'catalog'
 * creatives are ever read by the public feed or the dashboard's coverage
 * stats — see ASSET_TYPE_CONFIG in src/types/template.ts and migration 009.
 * Every `.in()` query against Supabase goes
 * through fetchAllChunked, which both chunks the input id list (PostgREST's
 * URL-length limit) and paginates each chunk's result (PostgREST's per-request
 * row cap) — chunking the input alone does not bound the output size; both are
 * required, see the constants just below for the production incidents that
 * made that necessary.
 *
 * RESPONSIBILITIES:
 *   - collectFilteredProductIds — every active product id for a store matching an optional tag/vendor/product_type filter
 *   - findUncoveredInStockVariants — in-stock variants with no generated_creatives row yet (restock detection)
 *   - getAdminClient — service-role Supabase client for worker/cron contexts with no browser session
 *   - computeGenerationRows — the exact (variant, image) fan-out a scope produces; shared by enqueue and estimate
 *   - enqueueGeneration — inserts generation_jobs rows and pushes them to BullMQ when Redis is configured
 *   - processBatch — DB-poll drain of pending jobs, claimed via select+update (no Postgres RPC required)
 *   - processGenerationJob — claim and run exactly one job (the BullMQ worker's entry point)
 *   - createJobContext — per-batch cache of template rules/canvases so a batch doesn't re-fetch them per job
 *
 * DEPENDENCIES: template-resolver (rule -> template matching), compositor (renders the creative),
 * product-layer-engine (cutout + background-plate bundle, replaces the old two-call AI pipeline),
 * cloudinary (final upload), queues (BullMQ enqueue), concurrency (mapWithConcurrency for processBatch).
 */

import { createClient as createSupabaseAdmin, SupabaseClient } from '@supabase/supabase-js'
// ws is required for Supabase Realtime on Node.js < 22 (no native WebSocket global)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as any
import {
  getActiveTemplateRules,
  resolveTemplateFromRules,
  TemplateRule,
} from '@/lib/template-resolver'
import { compositeImage } from '@/lib/compositor'
import { uploadBuffer } from '@/lib/cloudinary'
// CHANGED: replaced getTransparentProductImage + getReconstructedBackground with getProductLayerBundle
import { getProductLayerBundle } from '@/lib/product-layer-engine'
import { recordCreative } from '@/lib/creatives'
import { mapWithConcurrency } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { enqueueGenerationJobs, redisQueuesEnabled } from '@/lib/queues'
import type { CompositorBundle } from '@/types/product-layer'
import { buildRenderCanvas, type AssetType, type CanvasData } from '@/types/template'

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Chunked `.in()` Query Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PostgREST puts every `.in()` value into the request URL, not the body.
 * Empirically verified against this project's own Supabase instance: 300 UUIDs
 * (~11.8k char URL) succeeds, ~400+ returns a clean HTTP 400. A store with
 * more products/variants than this chunk size used to silently fall back to
 * `variants = []` (see the `console.warn`-and-continue this replaced), which
 * is the root cause of "all variants + all poses" only ever rendering one
 * fallback image per product — every product silently took the no-variant
 * legacy path once the ID list crossed this limit.
 */
const IN_QUERY_CHUNK_SIZE = 200

/**
 * Supabase/PostgREST caps rows returned per request (project default is
 * 1,000, via the API's "max rows" setting) regardless of how the `.in()` list
 * was chunked. A chunk of 200 PRODUCTS can still return many more than 1,000
 * VARIANT or IMAGE rows — one row per product is not the shape being
 * fetched — so chunking the input ids alone does not bound the output size.
 * Hit in production: with only IN_QUERY_CHUNK_SIZE applied, a 741-product
 * store returned a small, effectively arbitrary slice of its variants (no
 * error, no warning — PostgREST just returns up to its row cap and stops),
 * so "all variants + all poses" silently skipped most products **and**
 * specific in-stock variants within products it did reach, depending on
 * where in the untruncated-but-uncapped result set they happened to fall.
 */
const RESULT_PAGE_SIZE = 1000

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Run a `.in()`-based query across `ids` in chunks of IN_QUERY_CHUNK_SIZE
 * (keeps the request URL short), paginating each chunk's result in pages of
 * RESULT_PAGE_SIZE (keeps the response from being silently capped) — both are
 * needed; chunking the input alone does not bound the output. Throws on the
 * first page that errors — a partial result set here silently drops products
 * from the fan-out, which is strictly worse than failing the whole enqueue
 * loudly.
 *
 * `fetchPage`'s query MUST include a fully deterministic `.order(...)` (a
 * unique column, or a non-unique column plus a unique tiebreaker) — `.range()`
 * pagination re-runs the query per page, and without a stable sort Postgres
 * is free to return rows in a different order each time, which can duplicate
 * or silently drop rows across page boundaries.
 */
async function fetchAllChunked<T>(
  ids: string[],
  label: string,
  // Supabase query builders are PromiseLike (implement .then()) but not
  // strict Promise instances (no .catch()/.finally()) — same mismatch hit in
  // /api/generate/cancel/route.ts's `ops` array.
  fetchPage: (idChunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const results: T[] = []
  for (const idChunk of chunk(ids, IN_QUERY_CHUNK_SIZE)) {
    for (let from = 0; ; from += RESULT_PAGE_SIZE) {
      const { data, error } = await fetchPage(idChunk, from, from + RESULT_PAGE_SIZE - 1)
      if (error) throw new Error(`[${label}] chunked query failed: ${error.message}`)
      const page = data ?? []
      results.push(...page)
      if (page.length < RESULT_PAGE_SIZE) break
    }
  }
  return results
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Product / Variant Collection Helpers
// ═══════════════════════════════════════════════════════════════════════════

export interface ProductFilter {
  type?: 'tag' | 'vendor' | 'product_type'
  value?: string
}

/**
 * Every active product ID for a store matching an optional single-field
 * filter. Paginated at 1000/page (Supabase's default row cap per request).
 *
 * Shared by /api/generate/enqueue (the real submit) and /api/generate/estimate
 * (the pre-submit preview) — both need the identical product set a given
 * filter resolves to, or the preview count could disagree with what actually
 * gets enqueued.
 */
export async function collectFilteredProductIds(
  storeId: string,
  filter: ProductFilter | null | undefined,
  supabase: SupabaseClient
): Promise<string[]> {
  const productIds: string[] = []
  const PAGE = 1000
  let from = 0

  while (true) {
    let q = supabase
      .from('products')
      .select('id')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .range(from, from + PAGE - 1)

    if (filter?.type === 'tag'          && filter.value) q = q.contains('tags', [filter.value])
    else if (filter?.type === 'vendor'       && filter.value) q = q.eq('vendor', filter.value)
    else if (filter?.type === 'product_type' && filter.value) q = q.eq('product_type', filter.value)

    // .range() pagination needs a deterministic order — without one, Postgres
    // is free to return rows in a different order on each page's request.
    const { data: products, error } = await q.order('id', { ascending: true })
    if (error) throw new Error(error.message)
    if (!products || products.length === 0) break
    productIds.push(...products.map((p: any) => p.id))
    if (products.length < PAGE) break
    from += PAGE
  }

  return productIds
}

/**
 * In-stock variants (of active products) with no generated_creatives row yet
 * — newly restocked, or in stock since the store's first sync but never
 * covered. Used by the daily sync's auto-generate-on-restock check and the
 * dashboard's feed-coverage stat, so both agree on exactly what "uncovered"
 * means.
 *
 * PostgREST has no server-side anti-join through the JS client — a raw SQL
 * subquery is not a valid filter value, it can only compare a column against
 * a literal list — so this fetches both id sets and diffs them in JS. Same
 * pattern already used for the stale-variant reconciliation in
 * shopify-sync.ts's replaceProductVariants.
 */
async function fetchAllInStockVariants(
  storeId: string,
  supabase: SupabaseClient
): Promise<Array<{ id: string; product_id: string }>> {
  const PAGE = 1000
  const inStock: Array<{ id: string; product_id: string }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('product_variants')
      .select('id, product_id, products!inner(status)')
      .eq('store_id', storeId)
      .eq('is_sold_out', false)
      .eq('products.status', 'active')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`[findUncoveredInStockVariants] in-stock lookup failed: ${error.message}`)
    if (!data || data.length === 0) break
    inStock.push(...(data as any[]).map(v => ({ id: v.id, product_id: v.product_id })))
    if (data.length < PAGE) break
  }
  return inStock
}

async function fetchCoveredVariantIds(
  storeId: string,
  supabase: SupabaseClient
): Promise<Set<string>> {
  const PAGE = 1000
  const covered = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('generated_creatives')
      .select('variant_id')
      .eq('store_id', storeId)
      .not('variant_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`[findUncoveredInStockVariants] coverage lookup failed: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data as any[]) covered.add(row.variant_id)
    if (data.length < PAGE) break
  }
  return covered
}

export async function findUncoveredInStockVariants(
  storeId: string,
  supabase: SupabaseClient
): Promise<Array<{ id: string; product_id: string }>> {
  // Independent of each other — run concurrently rather than one after the
  // other. This is called on every Dashboard page load; for a non-trivial
  // catalog that used to mean two sequential rounds of paginated queries
  // back to back.
  const [inStock, covered] = await Promise.all([
    fetchAllInStockVariants(storeId, supabase),
    fetchCoveredVariantIds(storeId, supabase),
  ])
  if (inStock.length === 0) return []

  return inStock.filter(v => !covered.has(v.id))
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Supabase Admin Client
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Service-role Supabase client for contexts with no browser session — the
 * cron sync, the BullMQ worker — where RLS-scoped, cookie-based auth doesn't
 * apply. Passes `ws` as the realtime transport since Node.js < 22 has no
 * native WebSocket global.
 */
export function getAdminClient(): SupabaseClient {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      realtime: {
        // Node.js 20 has no native WebSocket global — must pass ws explicitly.
        transport: ws,
      },
      global: {
        headers: { 'x-client-info': 'catalog-worker' },
      },
    }
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Enqueue & Fan-Out
// ═══════════════════════════════════════════════════════════════════════════

export interface EnqueueArgs {
  storeId: string
  productIds: string[]      // internal product UUIDs
  creativeType?: string     // default 'default'
  batchId?: string
  /**
   * BullMQ job priority for this batch. Lower = processed sooner.
   * Set to the store's current pending-job count so stores with fewer
   * queued jobs are served first (fair round-robin across teams).
   * Defaults to 100 when not provided (low priority / FIFO).
   */
  basePriority?: number
  /**
   * Restrict to variants where one named option matches a value
   * (e.g. Size: M). Omitted/null generates every variant, unchanged.
   */
  variantOption?: { name: string; value: string } | null
  /**
   * Which of a variant's images to generate from.
   *
   *   'first' (default) — one job per variant, its first/primary image. This
   *      is the ORIGINAL behaviour (one job per variant, image chosen at
   *      render time) and is the default so every caller that doesn't pass
   *      this — the sync's auto-enqueue-on-change, in particular — keeps
   *      producing exactly the job count it always has.
   *   'all' — one job per variant PER IMAGE. Opt-in, from the Generate
   *      Creatives page's "All poses" scope.
   */
  imageScope?: 'all' | 'first'
  /**
   * Which placements to generate. One job per (variant, image, assetType) —
   * this multiplies the fan-out on top of variantOption/imageScope, so
   * requesting all four alongside "all variants + all poses" reaches
   * MAX_JOBS_PER_ENQUEUE much sooner than a catalog-only request would.
   * Defaults to ['catalog'] so every existing caller (the sync's
   * auto-enqueue-on-change, in particular) keeps producing exactly the same
   * jobs it always has.
   */
  assetTypes?: AssetType[]
}

/**
 * Above this, a single enqueue call is rejected rather than silently accepted.
 *
 * Fanning out per image multiplies job count by however many photos a variant
 * has: measured directly against this store's own catalog, "All variants +
 * All poses + All products" computes to ~47,570 jobs — comfortably under this
 * ceiling but well above the 5,000 this was previously set to (which existed
 * specifically to block that exact click). Raised because that combination is
 * a real, intentional merchant action, not a mistake to guard against; the
 * ceiling now exists only to catch genuinely pathological input.
 */
export const MAX_JOBS_PER_ENQUEUE = 50000

/**
 * Above this (but under MAX_JOBS_PER_ENQUEUE), the enqueue still proceeds —
 * this only changes what gets logged/surfaced, so a merchant clicking "All +
 * All" on a large catalog gets a heads-up rather than a silent multi-hour
 * queue.
 */
export const SOFT_WARN_JOBS = 10000

interface VariantRow {
  id: string
  product_id: string
  shopify_variant_id: string
  option1: string | null
  option2: string | null
  option3: string | null
  is_sold_out: boolean | null
}

export interface GenerationRow {
  store_id: string
  product_id: string
  variant_id?: string
  image_id?: string
  creative_type: string
  asset_type: AssetType
  status: string
  batch_id: string | null
}

export interface ComputeRowsArgs {
  storeId: string
  productIds: string[]
  creativeType?: string
  batchId?: string | null
  variantOption?: { name: string; value: string } | null
  imageScope?: 'all' | 'first'
  /** See EnqueueArgs.assetTypes. Defaults to ['catalog']. */
  assetTypes?: AssetType[]
}

/**
 * The exact (variant, image) fan-out a given scope produces. Shared between
 * the real enqueue below and the /api/generate/estimate endpoint, so the
 * "Will generate: N jobs" preview a merchant sees before clicking Generate is
 * the same number enqueueGeneration will actually insert — not a rough guess
 * computed a second, different way.
 */
export async function computeGenerationRows(
  {
    storeId, productIds, creativeType = 'default', batchId = null,
    variantOption = null, imageScope = 'first', assetTypes = ['catalog'],
  }: ComputeRowsArgs,
  supabase: SupabaseClient
): Promise<GenerationRow[]> {
  if (productIds.length === 0) return []

  // v2 fans out per VARIANT: each variant carries its own price, stock and
  // sold-out state, all of which appear in the creative's dynamic fields and
  // conditional badges. One job per product would render every colour/size with
  // variant[0]'s numbers.
  //
  // Products with no variant rows still get a single product-level job, so a
  // catalog that has not been re-synced since the variant migration keeps working.
  //
  // Chunked: an un-chunked .in() over a large productIds list failed outright
  // above ~300-400 UUIDs, and the previous console.warn-and-continue swallowed
  // that into `variants = []` — every product then silently took the
  // no-variant legacy branch below, which is why "all variants + all poses"
  // only ever rendered one fallback image per product on a large catalog.
  const allVariants = await fetchAllChunked<VariantRow>(
    productIds,
    'variant lookup',
    (idChunk, from, to) => supabase
      .from('product_variants')
      .select('id, product_id, shopify_variant_id, option1, option2, option3, is_sold_out')
      .in('product_id', idChunk)
      // id as a tiebreaker: position repeats across different products, and
      // .range() pagination needs a fully deterministic order to not
      // duplicate or drop rows between pages.
      .order('position', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )

  // Products with at least one synced variant row, in or out of stock — needed
  // below to tell "this product never had variants synced" (legacy
  // product-level path) apart from "it has variants, every one sold out"
  // (zero jobs — see the is_sold_out filter right after this).
  const productsWithVariantRows = new Set(allVariants.map(v => v.product_id))

  // In-Stock Only: a sold-out variant is never generated and never reaches the
  // feed (product_variants.is_sold_out is generated from inventory_quantity +
  // inventory_policy — see migration 002 — so this already accounts for
  // "continue" inventory policy variants that oversell and are never sold out
  // even at 0 stock). Filtered before the option-value scope so
  // filterVariantsByOption never needs to reason about stock itself.
  let variants = allVariants.filter(v => !v.is_sold_out)

  // ── Scope: specific option ────────────────────────────────────────────────
  if (variantOption && variantOption.name && variantOption.value) {
    variants = await filterVariantsByOption(variants, productIds, variantOption, supabase)
  }

  console.log(
    `[computeGenerationRows] ${variants.length} in-stock variant(s) matched across ` +
    `${productIds.length} product(s) — sold-out variants excluded`
  )

  const variantsByProduct = new Map<string, typeof variants>()
  for (const row of variants) {
    const list = variantsByProduct.get((row as any).product_id) ?? []
    list.push(row)
    variantsByProduct.set((row as any).product_id, list)
  }

  // ── Scope: images ─────────────────────────────────────────────────────────
  // Only fetched when at least one product has a variant to attach images to —
  // a store with variantOption filtering everything out shouldn't still pay
  // for this query.
  const imagesByProduct = variantsByProduct.size > 0
    ? await loadImagesByProduct(Array.from(variantsByProduct.keys()), supabase)
    : new Map<string, ImageRow[]>()

  const rows: GenerationRow[] = []

  for (const pid of productIds) {
    const productVariants = variantsByProduct.get(pid)

    // Legacy path: no synced variants for this product. Unaffected by
    // variantOption (nothing to filter) or imageScope (rare/pre-v2 data;
    // kept as the original single job, image chosen at render time) —
    // preserving exact prior behaviour for a path real stores no longer hit.
    if (!productVariants || productVariants.length === 0) {
      // Two different reasons a product can have no rows here, and only one
      // of them should fall back to a product-level job:
      //  - It never had variant rows synced at all (pre-v2 data) → legacy
      //    product-level job, same as always.
      //  - It DOES have variant rows, but every one was excluded — either
      //    sold out, or filtered out by variantOption — → zero jobs. A
      //    sold-out product must never fall back to a product-level job;
      //    that would silently generate (and feed) a creative for a product
      //    that is entirely out of stock, defeating the whole point of the
      //    is_sold_out filter above.
      if (variantOption || productsWithVariantRows.has(pid)) continue
      for (const assetType of assetTypes) {
        rows.push({
          store_id: storeId,
          product_id: pid,
          creative_type: creativeType,
          asset_type: assetType,
          status: 'pending',
          batch_id: batchId ?? null,
        })
      }
      continue
    }

    const productImages = imagesByProduct.get(pid) ?? []

    for (const variant of productVariants) {
      const images = imagesForVariant(productImages, (variant as any).shopify_variant_id, imageScope)
      for (const img of images) {
        for (const assetType of assetTypes) {
          rows.push({
            store_id: storeId,
            product_id: pid,
            variant_id: (variant as any).id,
            image_id: img.id,
            creative_type: creativeType,
            asset_type: assetType,
            status: 'pending',
            batch_id: batchId ?? null,
          })
        }
      }
    }
  }

  return rows
}

/**
 * Enqueue one generation job per (variant, image) — or per product, for a
 * product with no synced variants. Idempotent-ish: callers that re-enqueue the
 * same variant+image create a new job row; the worker upserts the resulting
 * creative by (variant, image, template) [or (product, template,
 * creative_type) for the legacy product-level path], so duplicates collapse
 * at write time rather than accumulating.
 */
export async function enqueueGeneration(
  {
    storeId, productIds, creativeType = 'default', batchId, basePriority = 100,
    variantOption = null, imageScope = 'first', assetTypes = ['catalog'],
  }: EnqueueArgs,
  supabase: SupabaseClient = getAdminClient()
): Promise<number> {
  if (productIds.length === 0) return 0

  console.log(
    `[enqueueGeneration] START storeId=${storeId} products=${productIds.length} ` +
    `batchId=${batchId ?? 'none'} variantOption=${variantOption ? `${variantOption.name}:${variantOption.value}` : 'none'} ` +
    `imageScope=${imageScope} assetTypes=${assetTypes.join(',')}`
  )

  const rows = await computeGenerationRows(
    { storeId, productIds, creativeType, batchId: batchId ?? null, variantOption, imageScope, assetTypes },
    supabase
  )

  if (rows.length === 0) {
    console.log('[enqueueGeneration] scope matched 0 jobs — nothing to enqueue')
    return 0
  }

  if (rows.length > MAX_JOBS_PER_ENQUEUE) {
    throw new Error(
      `This would enqueue ${rows.length.toLocaleString()} jobs, over the ${MAX_JOBS_PER_ENQUEUE.toLocaleString()} limit. ` +
      `Narrow the scope — a specific option value, "First pose only", or a product filter — and try again.`
    )
  }

  if (rows.length > SOFT_WARN_JOBS) {
    console.warn(
      `[enqueueGeneration] large enqueue: ${rows.length.toLocaleString()} jobs ` +
      `(soft-warn threshold ${SOFT_WARN_JOBS.toLocaleString()}) storeId=${storeId}`
    )
  }

  console.log(`[enqueueGeneration] fan-out: ${productIds.length} products → ${rows.length} variant×image jobs`)
  const { data, error } = await measureAsync(
    'queue.generation.db_enqueue',
    () => supabase
    .from('generation_jobs')
    .insert(rows)
    .select('id'),
    { rows: rows.length, storeId }
  )
  if (error) {
    console.error(`[enqueueGeneration] DB insert failed:`, error.message)
    throw new Error(error.message)
  }

  const insertedIds = (data || []).map((row: any) => row.id)
  console.log(`[enqueueGeneration] DB rows inserted: ${insertedIds.length} jobIds=[${insertedIds.slice(0, 3).join(',')}${insertedIds.length > 3 ? '…' : ''}]`)

  if (redisQueuesEnabled()) {
    console.log(`[enqueueGeneration] Redis enabled — pushing ${insertedIds.length} jobs to BullMQ queue`)
    try {
      const pushed = await measureAsync(
        'queue.generation.redis_enqueue',
        () => enqueueGenerationJobs(insertedIds, basePriority),
        { rows: insertedIds.length, storeId }
      )
      console.log(`[enqueueGeneration] Redis addBulk OK — pushed=${pushed}`)
    } catch (err) {
      console.error('[enqueueGeneration] Redis enqueue failed; DB queue remains available:', err)
    }
  } else {
    console.warn('[enqueueGeneration] REDIS_URL not set — jobs are in DB only, BullMQ worker will NOT receive them')
  }

  return insertedIds.length > 0 ? insertedIds.length : rows.length
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Variant / Image Scope-Filtering Helpers
// ═══════════════════════════════════════════════════════════════════════════

interface ImageRow {
  id: string
  product_id: string
  position: number | null
  is_primary: boolean | null
  variant_ids: string[] | null
}

interface ProductOptionNames {
  id: string
  option1_name: string | null
  option2_name: string | null
  option3_name: string | null
}

/**
 * Narrow a variant list down to the ones matching a named option's value.
 *
 * Prefers the NAMED column: products.option{1,2,3}_name records which
 * position is "Size" for that product (see migration 008), so filtering by
 * name doesn't rely on every product using the same option order.
 *
 * Falls back to checking all three positions for any product with no name
 * recorded — pre-migration-008 data, until the next sync. Case-insensitive on
 * both name and value, since merchants are inconsistent about casing
 * ("Size"/"size", "M"/"m").
 */
async function filterVariantsByOption<
  T extends { product_id: string; option1: string | null; option2: string | null; option3: string | null }
>(
  variants: T[],
  productIds: string[],
  option: { name: string; value: string },
  supabase: SupabaseClient
): Promise<T[]> {
  const products = await fetchAllChunked<ProductOptionNames>(
    productIds,
    'option-name lookup',
    (idChunk, from, to) => supabase
      .from('products')
      .select('id, option1_name, option2_name, option3_name')
      .in('id', idChunk)
      .order('id', { ascending: true })
      .range(from, to)
  )

  const wantName = option.name.trim().toLowerCase()
  const wantValue = option.value.trim().toLowerCase()

  const columnByProduct = new Map<string, 'option1' | 'option2' | 'option3' | null>()
  for (const p of products) {
    const names = [(p as any).option1_name, (p as any).option2_name, (p as any).option3_name]
    const idx = names.findIndex(n => typeof n === 'string' && n.trim().toLowerCase() === wantName)
    columnByProduct.set((p as any).id, idx === 0 ? 'option1' : idx === 1 ? 'option2' : idx === 2 ? 'option3' : null)
  }

  return variants.filter(v => {
    const column = columnByProduct.get(v.product_id)
    if (column) return (v[column] ?? '').trim().toLowerCase() === wantValue
    // No name recorded for this product — bridge fallback, see migration 008.
    return [v.option1, v.option2, v.option3].some(
      val => (val ?? '').trim().toLowerCase() === wantValue
    )
  })
}

/** All images for the given products, keyed by product_id. */
async function loadImagesByProduct(
  productIds: string[],
  supabase: SupabaseClient
): Promise<Map<string, ImageRow[]>> {
  const rows = await fetchAllChunked<ImageRow>(
    productIds,
    'image lookup',
    (idChunk, from, to) => supabase
      .from('product_images')
      .select('id, product_id, position, is_primary, variant_ids')
      .in('product_id', idChunk)
      .order('position', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )

  const byProduct = new Map<string, ImageRow[]>()
  for (const row of rows) {
    const list = byProduct.get(row.product_id) ?? []
    list.push(row)
    byProduct.set(row.product_id, list)
  }
  return byProduct
}

/**
 * Which images a variant should generate from, per the image scope.
 *
 * Mirrors the fallback already used on the product/variant detail page and
 * the Meta feed: a variant-specific image (Shopify's `variant.image`) wins
 * when Shopify recorded one, but most catalogs never assign images per
 * variant, so every variant falls back to the product's full image set.
 */
function imagesForVariant(
  productImages: ImageRow[],
  shopifyVariantId: string,
  imageScope: 'all' | 'first'
): ImageRow[] {
  const assigned = productImages.filter(img => (img.variant_ids ?? []).includes(shopifyVariantId))
  const pool = assigned.length > 0 ? assigned : productImages
  if (pool.length === 0) return []

  if (imageScope === 'all') return pool

  // 'first': the primary image if one is flagged, else whatever sorts first —
  // this is the same image runJob would have picked implicitly before jobs
  // carried an explicit image_id.
  return [pool.find(img => img.is_primary) ?? pool[0]]
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Job Processing (DB-poll batch drain + BullMQ single-job path)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Claim and process up to `batchSize` pending jobs directly from the DB.
 * Does NOT require any Postgres RPC function — uses a select+update pattern.
 * Safe for concurrent callers: each job is only claimed once via status check.
 */
export async function processBatch(
  batchSize = 10,
  concurrency = 4,
  supabase: SupabaseClient = getAdminClient()
): Promise<{ claimed: number; completed: number; failed: number }> {
  const { data: pendingJobs, error: selectError } = await supabase
    .from('generation_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (selectError) throw new Error(selectError.message)
  if (!pendingJobs || pendingJobs.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  const ids = pendingJobs.map((j: any) => j.id)

  // Step 1: Claim the jobs (mark processing)
  const { data: claimed, error: claimError } = await supabase
    .from('generation_jobs')
    .update({
      status:     'processing',
      locked_at:  new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('status', 'pending')
    .select('*')

  if (claimError) throw new Error(claimError.message)
  if (!claimed || claimed.length === 0) return { claimed: 0, completed: 0, failed: 0 }

  // Step 2: Increment attempts immediately after claiming.
  // This ensures that OOM crashes (where failJob never runs) still count as
  // an attempt — preventing infinite retry loops on jobs that always crash.
  const claimedIds = claimed.map((j: any) => j.id)
  await supabase.rpc('increment_job_attempts', { job_ids: claimedIds }).throwOnError()

  console.log(`[processBatch] Claimed ${claimed.length} jobs from DB`)

  let completed = 0
  let failed = 0
  const context = createJobContext()

  await mapWithConcurrency(claimed, concurrency, async job => {
    // Write a "started" timestamp so errors during crash can be diagnosed from logs
    await supabase.from('generation_jobs')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', job.id)

    try {
      await runJob(job, supabase, context)
      completed++
    } catch (err: any) {
      failed++
      const errMsg = err?.message ?? String(err)
      console.error(`[processBatch] Job failed jobId=${job.id} productId=${job.product_id}: ${errMsg}`)
      await failJob(job, errMsg, supabase)
    }
  })

  return { claimed: claimed.length, completed, failed }
}

/**
 * Claim and run exactly one job by id — the BullMQ worker's entry point (one
 * call per dequeued job, as opposed to processBatch's own DB-polling loop).
 * A no-op (returns `processed: false`) if the job isn't claimable, e.g. it was
 * already picked up by another worker or is no longer 'pending'.
 */
export async function processGenerationJob(
  jobId: string,
  supabase: SupabaseClient = getAdminClient(),
  /**
   * Optional shared cache of rules/template canvases. The BullMQ worker path
   * (this function's only caller) invokes it once per job, whereas the
   * DB-poll path (processBatch, below) already loops over a whole batch
   * itself and shares one context across it. Without a context passed in
   * here, a 739-job batch routed through BullMQ re-fetched the same store's
   * rules and the same templates up to 739 times — a fresh createJobContext()
   * per call, thrown away immediately after. Falls back to a fresh one so a
   * standalone call (tests, manual invocation) still works unchanged.
   */
  context?: JobContext
): Promise<{ processed: boolean; completed: boolean; failed: boolean }> {
  console.log(`[processGenerationJob] Claiming job jobId=${jobId}`)

  const { data: job, error } = await measureAsync(
    'queue.generation.claim_one',
    () => supabase
      .from('generation_jobs')
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle(),
    { jobId }
  )

  if (error) {
    console.error(`[processGenerationJob] Claim error jobId=${jobId}:`, error.message)
    throw new Error(error.message)
  }
  if (!job) {
    const { data: check } = await supabase
      .from('generation_jobs').select('status').eq('id', jobId).maybeSingle()
    console.warn(`[processGenerationJob] Job not claimable jobId=${jobId} current_status=${check?.status ?? 'not_found'} — skipping`)
    return { processed: false, completed: false, failed: false }
  }

  console.log(`[processGenerationJob] Processing jobId=${jobId} productId=${job.product_id} storeId=${job.store_id}`)

  try {
    await runJob(job, supabase, context ?? createJobContext())
    console.log(`[processGenerationJob] Completed jobId=${jobId} productId=${job.product_id}`)
    return { processed: true, completed: true, failed: false }
  } catch (err: any) {
    console.error(`[processGenerationJob] Failed jobId=${jobId} productId=${job.product_id}:`, err.message)
    await failJob(job, err.message, supabase)
    return { processed: true, completed: false, failed: true }
  }
}

export type JobContext = {
  rulesByStore: Map<string, Promise<TemplateRule[]>>
  templatesById: Map<string, Promise<any>>
}

/** A fresh, empty JobContext — one shared instance should live per batch of jobs. */
export function createJobContext(): JobContext {
  return {
    rulesByStore: new Map(),
    templatesById: new Map(),
  }
}

function getRulesForStore(storeId: string, context: JobContext) {
  const cached = context.rulesByStore.get(storeId)
  if (cached) return cached
  const promise = measureAsync(
    'supabase.template_rules.load',
    () => getActiveTemplateRules(storeId),
    { storeId }
  )
  context.rulesByStore.set(storeId, promise)
  return promise
}

function getTemplateCanvas(templateId: string, supabase: SupabaseClient, context: JobContext) {
  const cached = context.templatesById.get(templateId)
  if (cached) return cached
  const promise = measureAsync(
    'supabase.templates.load',
    async () => {
      const { data: template, error } = await supabase
        .from('templates')
        .select('canvas_data')
        .eq('id', templateId)
        .single()
      if (error) throw new Error(error.message)
      if (!template) throw new Error('Template not found')
      return template.canvas_data
    },
    { templateId }
  )
  context.templatesById.set(templateId, promise)
  return promise
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Render Pipeline
// ═══════════════════════════════════════════════════════════════════════════

async function runJob(job: any, supabase: SupabaseClient, context: JobContext) {
  const started = Date.now()

  // Load product and template rules in PARALLEL — previously sequential (~130ms saved).
  // Rules are cached in `context.templateRules` after the first call (see getRulesForStore),
  // so for subsequent jobs in the same batch the rules lookup is instant.
  const [productResult, rules] = await Promise.all([
    measureAsync(
      'supabase.products.load_for_generation',
      () => supabase
        .from('products')
        .select(`id, title, vendor, product_type, tags, price, compare_at_price, import_id, shot_type_override,
          product_images(id, src, cloudinary_url, is_primary)`)
        .eq('id', job.product_id)
        .single(),
      { productId: job.product_id }
    ),
    getRulesForStore(job.store_id, context),
  ])

  const { data: product, error: productError } = productResult
  if (productError) throw new Error(productError.message)
  if (!product) throw new Error('Product not found')

  // Placement this job renders — defaults to 'catalog' so every job enqueued
  // before migration 009 (asset_type NOT NULL DEFAULT 'catalog') behaves
  // identically to before. This does NOT gate rule/template resolution below:
  // a template's own asset_type is only a builder convenience (it seeds the
  // canvas to that placement's aspect ratio at creation time), not a filter
  // on which rules apply. One rule-matched template renders every placement
  // the merchant asked for on the Creatives page — see the canvas-dimension
  // override further down.
  const jobAssetType: AssetType = (job as any).asset_type ?? 'catalog'

  const templateId = job.template_id || resolveTemplateFromRules(
    {
      id: product.id,
      tags: product.tags || [],
      vendor: product.vendor,
      product_type: product.product_type,
      price: product.price,
      compare_at_price: product.compare_at_price,
    },
    rules
  )
  if (!templateId) {
    // 'skipped', not 'completed'. Nothing was generated, and calling that
    // completed made a stale worker indistinguishable from real success: 303
    // jobs reported completed while producing zero creatives, because the
    // deployed worker predated the multi-condition resolver and could not match
    // a rule defined by `conditions`. Nothing filters generation_jobs on
    // 'completed', so this is safe and makes the outcome countable.
    await supabase.from('generation_jobs')
      .update({
        status: 'skipped',
        error: 'no matching rule',
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
    return
  }
  const canvasData = await getTemplateCanvas(templateId, supabase, context)

  // Composite from the image THIS JOB was fanned out for, when the enqueue
  // step recorded one — falling back to primary/first for jobs enqueued
  // before image scoping existed, or the rare no-variant legacy path.
  // Without this, every job rendered the primary photo regardless of
  // job.image_id, making the "all poses" scope a no-op at render time even
  // though the fan-out had correctly created one job per image.
  const images = (product as any).product_images || []
  const chosenImage =
    ((job as any).image_id && images.find((i: any) => i.id === (job as any).image_id)) ||
    images.find((i: any) => i.is_primary) ||
    images[0]
  const imageUrl: string | null = chosenImage?.cloudinary_url || chosenImage?.src || null

  const templateMode: 'standard' | 'ai_product' | 'product_zoom' = (canvasData as any).templateMode || 'standard'

  // ── CHANGED: Product Layer Engine replaces the two separate AI calls ─────────
  //
  // Previously generation-queue.ts called:
  //   1. getTransparentProductImage()   → transparent cutout
  //   2. getReconstructedBackground()   → background plate (for 'original' mode only)
  //
  // Now it calls getProductLayerBundle() ONCE, which:
  //   - Returns all 3 assets (transparent + backgroundUrl + metadata) from cache if available
  //   - Runs AI only on first encounter of this source URL
  //   - Stores everything in bg_removal_cache (extended by migration SQL)
  //   - Is non-fatal: partial bundles (no backgroundUrl) still complete the job
  //
  // The compositor receives bundle.backgroundUrl via options.productLayerBundle,
  // which it uses as the fixed Background Plate in serverRenderBackground().
  // The compositor receives bundle.metadata via options.productLayerBundle,
  // which calculateSmartFitPlacement() uses for instant Head Space math.

  let productLayerBundle: CompositorBundle | null = null

  if (templateMode === 'ai_product' && imageUrl) {
    try {
      const bundle = await measureAsync(
        'product_layer_engine.get_bundle',
        () => getProductLayerBundle(imageUrl, job.store_id, supabase),
        { productId: product.id, templateId }
      )

      productLayerBundle = {
        transparentUrl: bundle.transparentUrl,
        backgroundUrl:  bundle.backgroundUrl,
        metadata:       bundle.metadata,
      }

      // Keep backward-compatible job tracking fields (existing dashboard reads these)
      await supabase.from('generation_jobs')
        .update({
          bg_removal_status: bundle.fromCache ? 'cached' : 'done',
          transparent_url:   bundle.transparentUrl,
          updated_at:        new Date().toISOString(),
        })
        .eq('id', job.id)

      console.log(
        `[runJob] Product Layer Bundle ${bundle.fromCache ? 'cached' : 'fresh'} ` +
        `status=${bundle.bundleStatus} shot=${bundle.metadata.shot_type} ` +
        `bgPlate=${bundle.backgroundUrl ? 'yes' : 'no'} jobId=${job.id}`
      )
    } catch (bundleErr: any) {
      // Non-fatal: fall back to standard mode (no transparent, no plate)
      console.error(`[runJob] Product Layer Bundle failed, falling back to standard:`, bundleErr.message)
      await supabase.from('generation_jobs')
        .update({ bg_removal_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', job.id)
    }
  } else if (templateMode === 'standard' || templateMode === 'product_zoom') {
    // product_zoom: no cutout is ever needed — the original photo is drawn
    // as a single unit (see compositor.ts's product_zoom branch).
    await supabase.from('generation_jobs')
      .update({ bg_removal_status: 'skipped', updated_at: new Date().toISOString() })
      .eq('id', job.id)
  }
  // ── End Product Layer Engine block ───────────────────────────────────────────

  const productLayerSettings = (canvasData as any).productLayerSettings || undefined

  // Load this job's variant, when it has one. Its price/sku/stock override the
  // product-level values so the creative shows the numbers for the exact
  // variant being advertised.
  let variant: any = null
  if ((job as any).variant_id) {
    const { data } = await supabase
      .from('product_variants')
      .select('id, title, sku, price, compare_at_price, inventory_quantity, is_sold_out, option1, option2, option3')
      .eq('id', (job as any).variant_id)
      .single()
    variant = data ?? null
  }

  // Placement dimensions come from the job's asset_type, not the template's
  // own stored canvas_data.width/height — see buildRenderCanvas's doc comment
  // for why, and why it forces the product-image layer to 'contain' whenever
  // the placement's aspect ratio differs from the template's own (never crop
  // the product just because a merchant asked for a different placement).
  const renderCanvas = buildRenderCanvas(canvasData as CanvasData, jobAssetType)

  const buffer = await compositeImage(renderCanvas as any, {
    title:           product.title,
    price:           variant?.price ?? product.price,
    compare_at_price: variant?.compare_at_price ?? product.compare_at_price,
    vendor:          product.vendor,
    product_type:    product.product_type,
    imageUrl,
    // v2 variant context — drives dynamic fields and conditional badges.
    sku:                variant?.sku ?? (product as any).sku ?? null,
    variant_title:      variant?.title ?? null,
    inventory_quantity: variant?.inventory_quantity ?? null,
    is_sold_out:        variant?.is_sold_out ?? null,
    option1:            variant?.option1 ?? null,
    option2:            variant?.option2 ?? null,
    option3:            variant?.option3 ?? null,
    // transparentImageUrl: sourced from bundle when present
    transparentImageUrl: productLayerBundle?.transparentUrl ?? null,
    shotTypeOverride:    (product as any).shot_type_override ?? null,
    // reconstructedBackgroundUrl: no longer needed — bundle.backgroundUrl handles this
    // via options.productLayerBundle in the compositor. Pass null to avoid legacy path.
    reconstructedBackgroundUrl: null,
  }, {
    templateMode,
    productLayerSettings,
    storeId:            job.store_id,
    supabase,
    // NEW: pass the full bundle so compositor can use Background Plate + Smart Fit 2.0
    productLayerBundle: productLayerBundle ?? undefined,
  })

  // JPEG output sanity check — FF D8 = JPEG Start Of Image marker.
  // (Previously checked for PNG magic bytes 0x89 0x50, which caused every job
  // to fail after the compositor was switched to JPEG output.)
  if (buffer.length < 1000 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    throw new Error('Invalid image buffer from compositor')
  }

  // Re-check for cancellation right before the costly network upload.
  //
  // Stop can only mark an already-'processing' row 'cancelled' — deleting a
  // mid-flight row risks FK issues on generation_jobs, and there is no way to
  // abort the canvas render already in progress above. But without this
  // check, a job that finished compositing just after Stop was clicked would
  // still upload to Cloudinary, write a generated_creatives row, and its own
  // final status update would blindly overwrite 'cancelled' back to
  // 'completed' — producing exactly the "Stop doesn't stop anything" symptom
  // this exists to fix. A missing row (defensive — nothing currently deletes
  // a 'processing' row) is treated the same way: discard, don't throw.
  const { data: liveStatus } = await supabase
    .from('generation_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle()

  if (!liveStatus || liveStatus.status === 'cancelled') {
    console.log(`[runJob] jobId=${job.id} cancelled mid-flight — discarding result, no upload`)
    return
  }

  // Variant AND image id are part of the public_id: without the variant id,
  // every variant of a product renders to the same Cloudinary asset; without
  // the image id, generating "all poses" for one variant would have every
  // image overwrite the last, leaving one creative where there should be
  // several. jobAssetType (not job.creative_type) is part of it too, so
  // catalog and feed/story/reel renders of the same variant+image+template
  // never collide on the same Cloudinary asset.
  const publicId = [
    'product', product.id,
    variant?.id ?? null,
    chosenImage?.id ?? null,
    templateId, jobAssetType,
  ].filter(Boolean).join('_')
  // Placement-scoped folder: catalog-creatives/{catalog,feed,story,reel}/... —
  // existing uploads (all pre-migration-009 rows are 'catalog') stay in the
  // root catalog-creatives/ folder they were already uploaded to; this only
  // affects new uploads going forward, matching how folder was previously
  // left at uploadBuffer's own 'catalog-creatives' default.
  const cloudinaryFolder = `catalog-creatives/${jobAssetType}`
  const { deliveredUrl, publicId: cloudPublicId } = await measureAsync(
    'cloudinary.upload',
    () => uploadBuffer(buffer, publicId, cloudinaryFolder),
    { productId: product.id, templateId, bytes: buffer.length }
  )

  // Legacy table — NOT asset_type-aware (it predates this feature and has no
  // such column). Keyed on (product_id, template_id, creative_type), which
  // stays 'default' across every asset type, so generating catalog + feed +
  // story for the same product/template overwrites this single row on every
  // write, leaving only whichever placement rendered last. Acceptable: this
  // table is vestigial (see creatives.ts) — nothing in the v2 UI, the feed, or
  // the dashboard reads it any more, only recordCreative's write below is load-bearing.
  const { error: upsertError } = await measureAsync(
    'supabase.generated_images.upsert',
    () => supabase.from('generated_images').upsert(
      {
        product_id:           product.id,
        template_id:          templateId,
        creative_type:        job.creative_type,
        cloudinary_public_id: cloudPublicId,
        generated_url:        deliveredUrl,
        status:               'completed',
        updated_at:           new Date().toISOString(),
      },
      { onConflict: 'product_id,template_id,creative_type' }
    ),
    { productId: product.id, templateId }
  )
  if (upsertError) throw new Error(upsertError.message)

  // Mirror into the v2 table the products UI and Meta feed read from.
  // imageId is the image ACTUALLY used (chosenImage), not just job.image_id —
  // a legacy job with no image_id still resolved to a real photo above, and
  // that is what the uniqueness in recordCreative needs to key on.
  await recordCreative({
    supabase,
    storeId: job.store_id,
    productId: product.id,
    variantId: (job as any).variant_id ?? null,
    imageId: chosenImage?.id ?? null,
    templateId,
    jobId: job.id,
    url: deliveredUrl,
    cloudinaryId: cloudPublicId,
    assetType: jobAssetType,
  })

  // Guarded on status still being 'processing': the upload above takes long
  // enough (network round trip) that a Stop click could land in that window
  // too. This can't undo the upload/recordCreative that already happened,
  // but it stops the row from being mis-reported 'completed' after being
  // cancelled — the merchant's view of what got stopped stays accurate.
  await supabase.from('generation_jobs')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'processing')

  logPerf('queue.generation.job_total', Date.now() - started, {
    jobId: job.id,
    productId: product.id,
    templateId,
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION — Failure Handling
// ═══════════════════════════════════════════════════════════════════════════

async function failJob(job: any, message: string, supabase: SupabaseClient) {
  // Re-read current attempts from DB (may have been incremented at claim time)
  const { data: current } = await supabase
    .from('generation_jobs')
    .select('attempts, max_attempts')
    .eq('id', job.id)
    .maybeSingle()

  const attempts   = current?.attempts    ?? job.attempts
  const maxAttempts = current?.max_attempts ?? job.max_attempts
  const willRetry  = attempts < maxAttempts

  await supabase.from('generation_jobs')
    .update({
      status:    willRetry ? 'pending' : 'failed',
      locked_at: null,
      error:     message?.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)

  if (!willRetry) {
    console.warn(`[generation-queue] Job permanently failed after ${attempts}/${maxAttempts} attempts: ${job.id}`)
  }
}