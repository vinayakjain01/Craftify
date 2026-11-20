/**
 * @module background-reconstruction
 *
 * Background Reconstruction Service (Cloudinary Generative Remove)
 *
 * RESPONSIBILITIES:
 *   - getReconstructionCacheKey — cache key for a source image's reconstructed background
 *   - getReconstructedBackground — detect the product's bounding box, run Cloudinary region-based Generative Remove, cache and return the plate URL (never throws — failures return { backgroundUrl: null, error })
 *   - invalidateReconstructionCache — delete a cached entry to force re-processing
 *
 * Opt-in companion to background-removal: instead of discarding the original
 * photo's background entirely, this reconstructs it — removing ONLY the
 * product-shaped region and inpainting it based on the surrounding pixels —
 * so the transparent cutout (produced separately, unchanged, by
 * src/lib/background-removal) can be placed back on what looks like its own
 * original backdrop instead of a synthetic solid/blur/gradient one.
 *
 * How it works:
 *  1. Detect the product's bounding box from the ALREADY-PRODUCED transparent
 *     cutout's alpha channel (reuses detectProductBounds from image-bounds.ts
 *     — the same utility Product Positioning uses, applied here for a
 *     different purpose).
 *  2. Pad that box slightly so Cloudinary sees the full object (a tight box
 *     risks leaving a sliver of the original product visible at the edges).
 *  3. Run Cloudinary's region-based Generative Remove (e_gen_remove) on the
 *     ORIGINAL (opaque) photo — NOT a text prompt, an exact pixel rectangle,
 *     since we already know precisely where the product is.
 *  4. Cache forever in background_reconstruction_cache, same convention as
 *     bg_removal_cache / image_extend_cache.
 *
 * This is a genuinely new, metered Cloudinary "Generative AI" feature —
 * separate cost from background removal or AI Extend. Every failure mode
 * here returns null rather than throwing, so callers fall back to today's
 * default (solid background) rather than breaking generation.
 *
 * Requires:
 *  - Cloudinary account with Generative Remove enabled
 *  - All existing CLOUDINARY_* env vars (already configured)
 *  - The products.background_reconstruction_cache table (manual migration —
 *    no migrations are checked into this repo, same as every other table)
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import type { SupabaseClient } from '@supabase/supabase-js'
import { detectProductBounds, verifyRegionChanged } from '@/lib/image-bounds'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ─── Cache key ────────────────────────────────────────────────────────────────

/**
 * Cache key for a source image's reconstructed background (sha256, salted
 * so it can't collide with the plain bg-removal cache key). Includes the
 * active Cloudinary cloud name so rotating Cloudinary credentials naturally
 * invalidates every previously-cached result instead of silently serving
 * back a dead URL under an account that no longer exists — see the same fix
 * in image-extend's getExtendCacheKey for why this matters.
 */
export function getReconstructionCacheKey(sourceUrl: string): string {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || ''
  return crypto.createHash('sha256').update(`${sourceUrl}|gen_remove|v1|${cloudName}`).digest('hex')
}

// ─── Async eager-transform polling ────────────────────────────────────────────
// Generative Remove is a heavier AI operation than Generative Fill (object
// detection + inpainting) — it does not reliably complete within a
// synchronous eager_async:false request the way image-extend's Generative
// Fill does. Mirrors the EXACT proven pattern already used in this codebase
// for a similarly heavy Cloudinary AI call: src/lib/background-removal/
// cloudinary-provider.ts's background_removal polling (2s interval, 60s cap).

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30 // 60 seconds max

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Region padding ───────────────────────────────────────────────────────────
// The alpha-channel bounding box can slightly under-cover the product at soft
// or anti-aliased edges. Padding the removal region prevents a visible sliver
// of the original product surviving at the boundary. This is a rectangle
// (Cloudinary's region-removal API is rectangle-only, not an arbitrary mask),
// so any real background inside the padded box that wasn't actually covered
// by the product also gets regenerated — an accepted, usually-imperceptible
// tradeoff on typical plain studio backdrops.

const REGION_PADDING_FRACTION = 0.08

// ─── Main service function ───────────────────────────────────────────────────

export interface ReconstructionResult {
  backgroundUrl: string | null
  cloudinaryId: string | null
  fromCache: boolean
  /** Set when backgroundUrl is null due to a failure — never thrown, always returned, so callers/UIs can show the real reason instead of a silent bypass. */
  error?: string
}

/**
 * Get the original background with the product region removed and inpainted.
 * Never throws — any failure comes back as { backgroundUrl: null, error }, so
 * callers can fall back to their existing default background (the fallback
 * behavior is unchanged; only the diagnostic detail is new) rather than fail
 * the whole generation.
 */
export async function getReconstructedBackground(
  sourceUrl: string,
  transparentCutoutUrl: string,
  storeId: string,
  supabase: SupabaseClient
): Promise<ReconstructionResult> {
  const cacheKey = getReconstructionCacheKey(sourceUrl)

  // 1. Check cache
  const { data: cached } = await supabase
    .from('background_reconstruction_cache')
    .select('background_url, cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[background-reconstruction] Cache HIT for ${sourceUrl.slice(0, 60)}...`)
    return { backgroundUrl: cached.background_url, cloudinaryId: cached.cloudinary_id, fromCache: true }
  }

  console.log(`[background-reconstruction] Cache MISS — running Generative Remove for ${sourceUrl.slice(0, 60)}...`)

  try {
    // 2. Detect the product's bounding box from the transparent cutout's alpha
    //    channel (the source photo itself has no alpha to detect against).
    const bounds = await detectProductBounds(transparentCutoutUrl)

    // 3. Pad the region.
    const contentW = bounds.right - bounds.left
    const contentH = bounds.bottom - bounds.top
    const padX = Math.round(contentW * REGION_PADDING_FRACTION)
    const padY = Math.round(contentH * REGION_PADDING_FRACTION)
    const regionX = Math.max(0, bounds.left - padX)
    const regionY = Math.max(0, bounds.top - padY)
    const regionRight = Math.min(bounds.imageWidth, bounds.right + padX)
    const regionBottom = Math.min(bounds.imageHeight, bounds.bottom + padY)
    const regionW = regionRight - regionX
    const regionH = regionBottom - regionY

    if (regionW <= 0 || regionH <= 0) {
      console.warn('[background-reconstruction] degenerate region, bypassing')
      return { backgroundUrl: null, cloudinaryId: null, fromCache: false, error: 'degenerate region (bounds detection produced an empty box)' }
    }

    // 4. Ensure source is on Cloudinary, then run region-based Generative Remove.
    const eagerPublicId = `bg-reconstructed/${cacheKey.slice(0, 24)}`

    // Cloudinary Generative Remove, region syntax: removes the given
    // rectangle and inpaints it from the surrounding pixels. NOTE: the exact
    // transformation string below is Cloudinary's documented region syntax
    // as of this writing (e_gen_remove:region_((x_..;y_..;w_..;h_..))) —
    // verify against a live Cloudinary account before relying on this in
    // production, since generative-AI transformation syntax has changed
    // before and isn't exercised by any existing code in this repo.
    const effect = `gen_remove:region_((x_${Math.round(regionX)};y_${Math.round(regionY)};w_${Math.round(regionW)};h_${Math.round(regionH)}))`

    const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
      public_id: eagerPublicId,
      folder: 'bg-reconstructed',
      overwrite: true,
      resource_type: 'image',
      eager: [{ effect, fetch_format: 'auto', quality: 'auto:best' }],
      eager_async: true, // Generative Remove is heavy (object detection + inpainting) —
                          // doesn't reliably finish synchronously; poll for it below,
                          // same proven pattern as background-removal/cloudinary-provider.ts.
    })

    const publicId = uploadResult.public_id
    let eagerResult = uploadResult.eager?.[0]

    if (!eagerResult?.secure_url) {
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS)
        const resource = await cloudinary.api.resource(publicId, { resource_type: 'image', eager: true }).catch(() => null)
        eagerResult = resource?.eager?.[0]
        if (eagerResult?.status === 'failed' || eagerResult?.error) break
        if (eagerResult?.secure_url) break
      }
    }

    if (eagerResult?.status === 'error' || eagerResult?.status === 'failed' || eagerResult?.error) {
      const reason = eagerResult?.error?.message || JSON.stringify(eagerResult)
      console.error('[background-reconstruction] Eager transform reported an error:', reason)
      return { backgroundUrl: null, cloudinaryId: null, fromCache: false, error: `Cloudinary eager transform error: ${reason}` }
    }
    if (!eagerResult?.secure_url) {
      console.error('[background-reconstruction] Generative Remove timed out after 60s, bypassing. Raw eager response:', JSON.stringify(eagerResult))
      return { backgroundUrl: null, cloudinaryId: null, fromCache: false, error: `Generative Remove timed out after 60s (last eager status: ${JSON.stringify(eagerResult)})` }
    }

    const backgroundUrl = eagerResult.secure_url
    const cloudinaryId = publicId

    // Cloudinary can report "success" while barely touching the removal
    // region (silent no-op / partial inpaint) — verify the region actually
    // changed before trusting this as a product-free plate. Otherwise the
    // compositor draws the sharp cutout on top of a plate that still shows
    // the product, producing a visible duplicate.
    const changed = await verifyRegionChanged(uploadResult.secure_url, backgroundUrl, {
      x: regionX, y: regionY, w: regionW, h: regionH,
    }).catch(() => true)

    if (!changed) {
      console.warn('[background-reconstruction] Generative Remove returned an unchanged region, bypassing')
      return { backgroundUrl: null, cloudinaryId: null, fromCache: false, error: 'Generative Remove returned an unchanged region — product likely still visible' }
    }

    // 5. Cache
    await supabase
      .from('background_reconstruction_cache')
      .upsert({
        cache_key: cacheKey,
        source_url: sourceUrl,
        background_url: backgroundUrl,
        cloudinary_id: cloudinaryId,
        store_id: storeId,
      }, { onConflict: 'cache_key' })

    console.log(`[background-reconstruction] Done. Reconstructed background: ${backgroundUrl}`)

    return { backgroundUrl, cloudinaryId, fromCache: false }
  } catch (err: any) {
    // Non-fatal by design — the caller falls back to the solid background —
    // but the real reason is now returned, not just logged server-side.
    const reason = err?.error?.message || err?.message || String(err)
    console.error('[background-reconstruction] Failed, bypassing:', reason)
    return { backgroundUrl: null, cloudinaryId: null, fromCache: false, error: reason }
  }
}

/**
 * Delete a cached entry (to force re-processing).
 */
export async function invalidateReconstructionCache(
  sourceUrl: string,
  supabase: SupabaseClient
): Promise<void> {
  const cacheKey = getReconstructionCacheKey(sourceUrl)
  const { data } = await supabase
    .from('background_reconstruction_cache')
    .select('cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (data?.cloudinary_id) {
    await cloudinary.uploader.destroy(data.cloudinary_id, { resource_type: 'image' }).catch(() => {})
  }

  await supabase
    .from('background_reconstruction_cache')
    .delete()
    .eq('cache_key', cacheKey)
}
