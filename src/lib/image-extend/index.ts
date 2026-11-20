/**
 * @module image-extend
 *
 * AI Image Extend Service (Cloudinary Generative Fill)
 *
 * RESPONSIBILITIES:
 *   - getExtendCacheKey — cache key for a centered extend result (source + target size)
 *   - needsExtend — whether a source image's aspect ratio differs enough from the canvas to be worth extending
 *   - getExtendedImage — centered AI extend: check cache, else run Cloudinary Generative Fill, cache and return the result URL
 *   - invalidateExtendCache — delete a cached centered-extend entry to force re-generation
 *   - getPositionedExtendCacheKey — cache key for a positioned extend result (source + target size + render offset)
 *   - getExtendedImagePositioned — like getExtendedImage but places the product at a specific offset instead of centering it (Product Zoom head-space positioning)
 *
 * Takes a product image URL and a target canvas size, and returns a new
 * image URL where the original product is centered with AI-generated
 * background naturally filling the empty canvas regions.
 *
 * How Cloudinary Generative Fill works:
 *  1. Upload the source image to Cloudinary (if not already there)
 *  2. Request a transformation with c_pad + b_gen_fill at the target dimensions
 *  3. Cloudinary AI generates the missing background regions
 *  4. The original product pixels are NEVER modified
 *  5. Result is a fully filled image at exactly target_width × target_height
 *
 * Caching:
 *  Every source_url + width + height combination is cached forever in
 *  image_extend_cache. Re-generating the same product for the same template
 *  never costs an extra Cloudinary AI credit.
 *
 * Requires:
 *  - Cloudinary account with Generative Fill enabled
 *    (Cloudinary Media Library → Settings → Add-ons → Generative Fill)
 *  - All existing CLOUDINARY_* env vars (already configured)
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import type { SupabaseClient } from '@supabase/supabase-js'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ─── Cache key ────────────────────────────────────────────────────────────────

/**
 * Cache key for a centered extend result — source URL + target dimensions.
 *
 * Includes the active Cloudinary cloud name so rotating Cloudinary
 * credentials naturally invalidates every previously-cached result instead
 * of silently serving back a dead URL under an account that no longer
 * exists — confirmed happening in practice: cached rows from a prior cloud
 * name were still being returned as cache hits after switching accounts,
 * each one a permanently broken image with no error anywhere.
 */
export function getExtendCacheKey(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number
): string {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || ''
  return crypto
    .createHash('sha256')
    .update(`${sourceUrl}|${targetWidth}|${targetHeight}|ai_extend|cloudinary|${cloudName}`)
    .digest('hex')
}

// ─── Smart skip detection ─────────────────────────────────────────────────────
// Before calling the AI, calculate whether the image already fills the canvas.
// If the image's aspect ratio matches the canvas within 1%, skip the AI call.
// This prevents wasting credits on images that are already the right shape.

export function needsExtend(
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number
): boolean {
  if (!imageWidth || !imageHeight) return false
  const imageAr = imageWidth / imageHeight
  const canvasAr = canvasWidth / canvasHeight
  // Within 1% aspect ratio match means almost no empty space
  return Math.abs(imageAr - canvasAr) / canvasAr > 0.01
}

// ─── Upload source image to Cloudinary ───────────────────────────────────────
// If the product image is already a Cloudinary URL, we can derive the public_id
// directly and skip the upload. Otherwise, upload it first.

async function ensureOnCloudinary(sourceUrl: string): Promise<string> {
  // Already a Cloudinary URL — extract public_id from URL
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  if (sourceUrl.includes(`res.cloudinary.com/${cloudName}`)) {
    // Extract public_id: everything between /upload/[version/] and the extension
    const match = sourceUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/)
    if (match) return match[1]
  }

  // Not on Cloudinary yet — upload it as a source image
  const result = await cloudinary.uploader.upload(sourceUrl, {
    folder: 'extend-sources',
    // Use a deterministic public_id based on the URL hash so we don't
    // upload the same source image twice across different extend calls
    public_id: `src_${crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`,
    overwrite: false,       // skip if already uploaded
    resource_type: 'image',
  })
  return result.public_id
}

// ─── Wait for AI processing to actually finish ───────────────────────────────
//
// This module's original comments assumed Generative Fill "reliably completes
// synchronously" under eager_async: false, unlike the heavier Generative
// Remove call in background-reconstruction/index.ts. That assumption was
// wrong: b_gen_fill also ignores eager_async: false — the upload call returns
// almost immediately with eager[0].status === 'processing' AND a populated
// secure_url that nonetheless 423s (Locked) for anywhere from ~2s to 15s+
// depending on Cloudinary's AI queue — the field being present is not a
// readiness signal. Treating that URL as immediately usable was a race:
// whichever caller loaded it first — the compositor rendering a creative, or
// the builder's live preview <img> tag — sometimes won and sometimes got a
// 423 and a broken/gray result.
//
// background-reconstruction/index.ts's own comments cite polling
// cloudinary.api.resource(publicId, { eager: true }) as "the proven pattern"
// for this exact class of problem, but verified directly against this
// account: for gen_fill, that Admin API lookup never returns an `eager` array
// at all (always undefined) — polling it would spin for the full 60s cap on
// every single call. What DOES reliably work, confirmed by direct testing: a
// plain HEAD request against the transformation URL itself — 423 while
// Cloudinary is still generating it, 200 the moment it's ready.

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30 // 60 seconds max

async function waitForCloudinaryAsset(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.ok) return true
      if (res.status !== 423) return false // a real failure — polling won't fix it
    } catch {
      // transient network hiccup — keep polling
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

// ─── Main extend function ─────────────────────────────────────────────────────

export interface ExtendResult {
  extendedUrl: string
  cloudinaryId: string
  fromCache: boolean
}

/**
 * Get the AI-extended version of a product image at the target canvas size.
 * Checks cache first — only calls Cloudinary AI if the combination is new.
 *
 * @param sourceUrl   Original product image URL (Shopify CDN or any public URL)
 * @param targetWidth  Canvas width in pixels (e.g. 1080)
 * @param targetHeight Canvas height in pixels (e.g. 1080)
 * @param storeId      For cache scoping (RLS)
 * @param supabase     Admin Supabase client
 */
export async function getExtendedImage(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  storeId: string,
  supabase: SupabaseClient
): Promise<ExtendResult> {
  const cacheKey = getExtendCacheKey(sourceUrl, targetWidth, targetHeight)

  // 1. Check cache
  const { data: cached } = await supabase
    .from('image_extend_cache')
    .select('extended_url, cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[image-extend] Cache HIT ${targetWidth}x${targetHeight} for ${sourceUrl.slice(0, 60)}`)
    return {
      extendedUrl: cached.extended_url,
      cloudinaryId: cached.cloudinary_id,
      fromCache: true,
    }
  }

  console.log(`[image-extend] Cache MISS — running generative fill ${targetWidth}x${targetHeight} for ${sourceUrl.slice(0, 60)}`)

  // 2. Ensure source image is on Cloudinary
  const publicId = await ensureOnCloudinary(sourceUrl)

  // 3. Build the Cloudinary transformation URL with generative fill
  //
  // Transformation breakdown:
  //  w_{targetWidth},h_{targetHeight}  — target output dimensions
  //  c_pad                              — pad (letterbox) to target size using contain mode
  //  b_gen_fill                         — AI generative fill for the padded regions
  //  ar_{aspect_ratio_fraction}         — ensure correct aspect ratio computation
  //
  // Cloudinary processes this lazily on first URL access. The response is
  // cached on Cloudinary's CDN after the first generation.
  const transformedUrl = cloudinary.url(publicId, {
    width: targetWidth,
    height: targetHeight,
    crop: 'pad',
    background: 'gen_fill',
    fetch_format: 'png',
    quality: 'auto:best',
  })

  // 4. Trigger eager generation so we can download the buffer immediately
  //    (vs. waiting for the first URL access to trigger the transformation)
  const eagerPublicId = `extend-results/${cacheKey.slice(0, 24)}`

  let finalUrl: string
  let finalCloudinaryId: string

  try {
    // Upload with eager transformation to pre-generate the result.
    // public_id already starts with 'extend-results/' — adding folder:
    // 'extend-results' on top made Cloudinary prepend it a second time,
    // landing every result under extend-results/extend-results/<hash>.
    const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
      public_id: eagerPublicId,
      overwrite: true,
      resource_type: 'image',
      eager: [
        {
          width: targetWidth,
          height: targetHeight,
          crop: 'pad',
          background: 'gen_fill',
          fetch_format: 'auto',
          quality: 'auto:best',
        },
      ],
      eager_async: false,
    })

    // eager[0].secure_url is populated even while status is 'processing' — it
    // names where the result WILL be, not that it's there yet. waitForCloudinaryAsset
    // below is what actually confirms it's safe to hand out and cache.
    const eagerResult = uploadResult.eager?.[0]
    if (eagerResult?.secure_url) {
      finalUrl = eagerResult.secure_url
      finalCloudinaryId = uploadResult.public_id
    } else {
      // Fallback: use the URL-based transformation (Cloudinary generates on first access)
      finalUrl = transformedUrl
      finalCloudinaryId = publicId
    }
  } catch (err: any) {
    console.error('[image-extend] Eager upload failed, falling back to URL transform:', err.message)
    // The URL-based approach still works — just triggers generation on first view
    finalUrl = transformedUrl
    finalCloudinaryId = publicId
  }

  // Don't hand back (or cache) a URL that still 423s — wait for Cloudinary's
  // AI generation to actually finish so every caller gets a working image on
  // its very first load.
  const ready = await waitForCloudinaryAsset(finalUrl)
  if (!ready) {
    console.warn(`[image-extend] Asset still not ready after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms, returning anyway: ${finalUrl}`)
  }

  // 5. Store in cache
  await supabase
    .from('image_extend_cache')
    .upsert({
      cache_key: cacheKey,
      source_url: sourceUrl,
      extended_url: finalUrl,
      cloudinary_id: finalCloudinaryId,
      width: targetWidth,
      height: targetHeight,
      fit_mode: 'ai_extend',
      provider: 'cloudinary',
      store_id: storeId,
    }, { onConflict: 'cache_key' })

  console.log(`[image-extend] Done. Extended image: ${finalUrl}`)

  return {
    extendedUrl: finalUrl,
    cloudinaryId: finalCloudinaryId,
    fromCache: false,
  }
}

/**
 * Invalidate a cached extend result (forces re-generation on next use).
 */
export async function invalidateExtendCache(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  supabase: SupabaseClient
): Promise<void> {
  const cacheKey = getExtendCacheKey(sourceUrl, targetWidth, targetHeight)
  const { data } = await supabase
    .from('image_extend_cache')
    .select('cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (data?.cloudinary_id) {
    await cloudinary.uploader.destroy(data.cloudinary_id).catch(() => {})
  }

  await supabase
    .from('image_extend_cache')
    .delete()
    .eq('cache_key', cacheKey)
}
// ─── Positioned extend ────────────────────────────────────────────────────────
//
// Like getExtendedImage but places the SOURCE image at a specific position
// within the target canvas instead of centering it. Used by Product Zoom mode
// when head-space / bottom-space positioning moves the product to a non-center
// location, leaving canvas areas above/below/left/right that need AI fill.
//
// Cloudinary's c_pad always centers the source. To offset it we:
//  1. Pad the source image to a larger intermediate canvas that equals the
//     target canvas but with the source at the correct offset, using solid
//     background color for the intermediate padding.
//  2. Apply b_gen_fill to the intermediate to replace the solid padding with
//     AI-generated background that matches the image content.
//
// The cache key includes the offset so each position combo is cached separately.

/**
 * Cache key for a positioned extend result — includes the render offset so
 * each position combo caches separately, and the active Cloudinary cloud
 * name so rotating Cloudinary credentials naturally invalidates every
 * previously-cached result (see getExtendCacheKey's comment for why).
 */
export function getPositionedExtendCacheKey(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  offsetX: number,
  offsetY: number,
  renderedW: number,
  renderedH: number
): string {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || ''
  return crypto
    .createHash('sha256')
    .update(`${sourceUrl}|${targetWidth}|${targetHeight}|${offsetX}|${offsetY}|${renderedW}|${renderedH}|positioned_extend_v1|${cloudName}`)
    .digest('hex')
}

export interface PositionedExtendResult {
  extendedUrl: string
  cloudinaryId: string
  fromCache: boolean
}

/**
 * Extend a product image with AI-generated background so it fills the entire
 * target canvas, with the product placed at the given pixel offset.
 *
 * imgX/imgY/renderedW/renderedH are the 1× canvas coordinates of the product.
 * Values may be negative (product extends above/left of canvas).
 */
export async function getExtendedImagePositioned(
  sourceUrl: string,
  targetWidth: number,
  targetHeight: number,
  imgX: number,
  imgY: number,
  renderedW: number,
  renderedH: number,
  storeId: string,
  supabase: SupabaseClient
): Promise<PositionedExtendResult> {
  const cacheKey = getPositionedExtendCacheKey(
    sourceUrl, targetWidth, targetHeight,
    Math.round(imgX), Math.round(imgY),
    Math.round(renderedW), Math.round(renderedH)
  )

  // Check cache
  const { data: cached } = await supabase
    .from('image_extend_cache')
    .select('extended_url, cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[image-extend/positioned] Cache HIT ${targetWidth}x${targetHeight} offset=(${Math.round(imgX)},${Math.round(imgY)})`)
    return { extendedUrl: cached.extended_url, cloudinaryId: cached.cloudinary_id, fromCache: true }
  }

  console.log(`[image-extend/positioned] Cache MISS — ${targetWidth}x${targetHeight} offset=(${Math.round(imgX)},${Math.round(imgY)}) for ${sourceUrl.slice(0, 60)}`)

  const publicId = await ensureOnCloudinary(sourceUrl)

  // Cloudinary's c_pad centers the image. To place at offset (imgX, imgY)
  // we use x/y gravity offset with gravity=north_west.
  //
  // The source image will be scaled to renderedW×renderedH, then placed
  // at (imgX, imgY) within the target canvas, with b_gen_fill filling the rest.
  //
  // Cloudinary transformation:
  //  c_scale,w_{rW},h_{rH}           — scale source to rendered size
  //  c_pad,w_{targetW},h_{targetH},
  //    gravity=north_west,x_{ix},y_{iy},
  //    b_gen_fill                    — pad to canvas with AI fill, offset from top-left
  //
  // Negative offsets (image starts above/left of canvas): clamp to 0 since
  // Cloudinary can't place images before the canvas origin. In that case the
  // product extends to the edge naturally (canvas clips it).

  const clampedX = Math.max(0, Math.round(imgX))
  const clampedY = Math.max(0, Math.round(imgY))

  const eagerPublicId = `extend-results/pos_${cacheKey.slice(0, 24)}`
  let finalUrl: string
  let finalCloudinaryId: string

  try {
    const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
      public_id: eagerPublicId,
      overwrite: true,
      resource_type: 'image',
      eager: [
        {
          transformation: [
            // Step 1: Scale the source image to rendered dimensions
            { width: Math.round(renderedW), height: Math.round(renderedH), crop: 'scale' },
            // Step 2: Pad out to the full target canvas, placing at offset from top-left
            // gravity: 'north_west' + x/y places the image at (x, y) from top-left corner
            {
              width: targetWidth,
              height: targetHeight,
              crop: 'pad' as any,
              background: 'gen_fill',
              gravity: 'north_west',
              x: clampedX,
              y: clampedY,
            },
          ],
          fetch_format: 'auto',
          quality: 'auto:best',
        },
      ],
      eager_async: false,
    })

    // Same caveat as getExtendedImage: secure_url is populated regardless of
    // whether it's actually ready — waitForCloudinaryAsset below confirms it.
    const eagerResult = uploadResult.eager?.[0]
    if (eagerResult?.secure_url) {
      finalUrl = eagerResult.secure_url
      finalCloudinaryId = uploadResult.public_id
    } else {
      // Fallback to URL-based transform
      finalUrl = cloudinary.url(publicId, {
        transformation: [
          { width: Math.round(renderedW), height: Math.round(renderedH), crop: 'scale' },
          { width: targetWidth, height: targetHeight, crop: 'pad', background: 'gen_fill',
            gravity: 'north_west', x: clampedX, y: clampedY } as any,
        ],
        fetch_format: 'png',
        quality: 'auto:best',
      })
      finalCloudinaryId = publicId
    }
  } catch (err: any) {
    console.error('[image-extend/positioned] Failed, falling back to centered extend:', err.message)
    // Fallback: use plain centered extend
    const fallback = await getExtendedImage(sourceUrl, targetWidth, targetHeight, storeId, supabase)
    return { ...fallback, fromCache: false }
  }

  // Same race as getExtendedImage: wait for it to actually be servable.
  const ready = await waitForCloudinaryAsset(finalUrl)
  if (!ready) {
    console.warn(`[image-extend/positioned] Asset still not ready after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms, returning anyway: ${finalUrl}`)
  }

  // Store in cache
  await supabase
    .from('image_extend_cache')
    .upsert({
      cache_key: cacheKey,
      source_url: sourceUrl,
      extended_url: finalUrl,
      cloudinary_id: finalCloudinaryId,
      width: targetWidth,
      height: targetHeight,
      fit_mode: 'ai_extend',
      provider: 'cloudinary',
      store_id: storeId,
    }, { onConflict: 'cache_key' })

  console.log(`[image-extend/positioned] Done: ${finalUrl.slice(0, 80)}`)
  return { extendedUrl: finalUrl, cloudinaryId: finalCloudinaryId, fromCache: false }
}