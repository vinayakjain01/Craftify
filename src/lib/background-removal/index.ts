/**
 * @module background-removal
 *
 * Background Removal Service
 *
 * RESPONSIBILITIES:
 *   - getCacheKey — cache key for a source image's transparent-cutout result
 *   - getTransparentProductImage — check cache, else run the configured provider (with fallback chain), upload the transparent PNG to Cloudinary, cache and return its URL
 *   - invalidateBgRemovalCache — delete a cached entry to force re-processing
 *
 * Central orchestration layer. Responsibilities:
 *  1. Check DB cache — return cached transparent PNG if exists
 *  2. If not cached, call the configured AI provider
 *  3. Upload the transparent PNG to Cloudinary for permanent storage
 *  4. Save the result to bg_removal_cache table
 *  5. Return the Cloudinary URL of the transparent PNG
 *
 * Provider is configurable via BG_REMOVAL_PROVIDER env var.
 * Default: 'cloudinary' (uses Cloudinary AI add-on)
 *
 * Options: 'removebg' (best quality, recommended for fashion/apparel),
 * 'clipdrop', 'cloudinary'.
 *
 * Optional fallback chain via BG_REMOVAL_FALLBACK_PROVIDERS (comma-separated,
 * e.g. "clipdrop,cloudinary") — tried in order if the primary provider fails
 * (out of credits, API down, etc.) so production generation never fully breaks.
 */

import crypto from 'crypto'
import { v2 as cloudinary } from 'cloudinary'
import { SupabaseClient } from '@supabase/supabase-js'
import type { BackgroundRemovalProvider, ProviderName } from './provider'

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// ─── Provider factory ─────────────────────────────────────────────────────────

function instantiateProvider(name: ProviderName): BackgroundRemovalProvider {
  switch (name) {
    case 'fal-birefnet': {
      const { FalBirefnetProvider } = require('./fal-birefnet-provider')
      return new FalBirefnetProvider()
    }
    case 'removebg': {
      const { RemoveBgProvider } = require('./removebg-provider')
      return new RemoveBgProvider()
    }
    case 'clipdrop': {
      const { ClipdropBackgroundRemovalProvider } = require('./clipdrop-provider')
      return new ClipdropBackgroundRemovalProvider()
    }
    case 'cloudinary':
    default: {
      const { CloudinaryBackgroundRemovalProvider } = require('./cloudinary-provider')
      return new CloudinaryBackgroundRemovalProvider()
    }
  }
}

function getConfiguredProvider(): BackgroundRemovalProvider {
  const name = (process.env.BG_REMOVAL_PROVIDER || 'cloudinary') as ProviderName
  return instantiateProvider(name)
}

/**
 * Ordered fallback chain. If BG_REMOVAL_FALLBACK_PROVIDERS is set (comma
 * separated, e.g. "clipdrop,cloudinary"), those providers are tried in order
 * after the primary fails — covers cases like "remove.bg ran out of credits
 * this month" without breaking production generation.
 */
function getFallbackProviders(): BackgroundRemovalProvider[] {
  const raw = process.env.BG_REMOVAL_FALLBACK_PROVIDERS
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(name => instantiateProvider(name as ProviderName))
}

// ─── Cache key ────────────────────────────────────────────────────────────────

/**
 * Cache key for a source image's transparent-cutout result.
 *
 * Includes the active Cloudinary cloud name so rotating Cloudinary
 * credentials naturally invalidates every previously-cached result instead
 * of silently serving back a dead URL under an account that no longer
 * exists — confirmed happening in practice: cached rows from two prior
 * cloud names were still being returned as cache hits after switching
 * accounts, each one a permanently broken image with no error anywhere.
 */
export function getCacheKey(imageUrl: string): string {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || ''
  return crypto.createHash('sha256').update(`${imageUrl}|${cloudName}`).digest('hex')
}

// ─── Main service function ───────────────────────────────────────────────────

export interface BgRemovalResult {
  transparentUrl: string
  cloudinaryId: string
  fromCache: boolean
  provider: string
}

/**
 * Get the transparent PNG for a product image.
 * Checks cache first, calls AI provider if needed.
 * Never removes the same background twice.
 */
export async function getTransparentProductImage(
  sourceUrl: string,
  storeId: string,
  supabase: SupabaseClient
): Promise<BgRemovalResult> {
  const cacheKey = getCacheKey(sourceUrl)

  // 1. Check cache
  const { data: cached } = await supabase
    .from('bg_removal_cache')
    .select('transparent_url, cloudinary_id, provider')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached) {
    console.log(`[bg-removal] Cache HIT for ${sourceUrl.slice(0, 60)}...`)
    return {
      transparentUrl: cached.transparent_url,
      cloudinaryId: cached.cloudinary_id,
      fromCache: true,
      provider: cached.provider,
    }
  }

  console.log(`[bg-removal] Cache MISS — calling AI provider for ${sourceUrl.slice(0, 60)}...`)

  // 2. Download the source image
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let imageBuffer: Buffer
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal })
    if (!res.ok) throw new Error(`Failed to fetch source image: ${res.status}`)
    imageBuffer = Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }

  // 3. Call provider — try primary, then fall back through
  //    BG_REMOVAL_FALLBACK_PROVIDERS in order if it fails (e.g. out of credits).
  const primary = getConfiguredProvider()
  const fallbacks = getFallbackProviders()
  const chain = [primary, ...fallbacks]

  let transparentBuffer: Buffer | null = null
  let usedProvider = primary
  let lastError: Error | null = null

  for (const candidate of chain) {
    try {
      console.log(`[bg-removal] Trying provider: ${candidate.name}`)
      transparentBuffer = await candidate.removeBackground(imageBuffer, sourceUrl)
      usedProvider = candidate
      break
    } catch (err: any) {
      lastError = err
      console.error(`[bg-removal] Provider ${candidate.name} failed: ${err.message}`)
    }
  }

  if (!transparentBuffer) {
    throw lastError || new Error('All background removal providers failed')
  }

  // 4. Upload transparent PNG to Cloudinary (permanent storage)
  const publicId = `transparent-products/${cacheKey.slice(0, 16)}`
  const cloudinaryResult = await new Promise<any>((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 'bg-removed',
        resource_type: 'image',
        overwrite: true,
        format: 'png', // must stay PNG for transparency
      },
      (error, result) => {
        if (error || !result) return reject(error || new Error('Cloudinary upload failed'))
        resolve(result)
      }
    ).end(transparentBuffer)
  })

  const transparentUrl = cloudinaryResult.secure_url
  const cloudinaryId = cloudinaryResult.public_id

  // 5. Save to cache (upsert in case of race condition)
  await supabase
    .from('bg_removal_cache')
    .upsert({
      cache_key: cacheKey,
      source_url: sourceUrl,
      transparent_url: transparentUrl,
      cloudinary_id: cloudinaryId,
      provider: usedProvider.name,
      store_id: storeId,
    }, { onConflict: 'cache_key' })

  console.log(`[bg-removal] Done. Transparent PNG uploaded: ${transparentUrl}`)

  return {
    transparentUrl,
    cloudinaryId,
    fromCache: false,
    provider: usedProvider.name,
  }
}

/**
 * Delete a cached entry (to force re-processing).
 */
export async function invalidateBgRemovalCache(
  sourceUrl: string,
  supabase: SupabaseClient
): Promise<void> {
  const cacheKey = getCacheKey(sourceUrl)
  const { data } = await supabase
    .from('bg_removal_cache')
    .select('cloudinary_id')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (data?.cloudinary_id) {
    await cloudinary.uploader.destroy(data.cloudinary_id, { resource_type: 'image' }).catch(() => {})
  }

  await supabase
    .from('bg_removal_cache')
    .delete()
    .eq('cache_key', cacheKey)
}