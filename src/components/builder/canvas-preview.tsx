'use client'

import { useRef, useCallback, useState, useEffect } from 'react'
import { useBuilderStore } from '@/stores/builder-store'
import {
  Layer, TextLayer, ImageLayer, RectangleLayer, BadgeLayer,
  LogoLayer, OverlayLayer, StickerLayer, resolveVariables,
  DEFAULT_BACKGROUND_SETTINGS, DEFAULT_PRODUCT_LAYER_SETTINGS, PRODUCT_LAYER_ID,
} from '@/types/template'
import { useSmartBackground } from './smart-background'
import { useExtendPreview } from './use-extend-preview'
// CHANGED: replaced useTransparentPreview + useProductBounds + useBackgroundReconstructionPreview
// with the unified useProductLayerBundle hook
import { useProductLayerBundle } from './use-product-layer-bundle'
import { ProductPositioningGuide } from './product-positioning-guide'
import {
  placementToProductLayerSettings,
  calculatePlacement,
  calculateSmartFitPlacement,
  computeClassificationSignals,
  classifyShotType,
  isDegenerateBounds,
  type ProductBounds,
  type HeadSpacePlacement,
} from '@/lib/product-positioning-shared'
import type { ProductPositioningSettings, ShotType } from '@/types/template'
import type { ProductLayerMetadata } from '@/types/product-layer'
import { Loader2, Sparkles, Wand2 } from 'lucide-react'

const MAX_W = 580
const MAX_H = 680

const SAMPLE_PRODUCT = {
  title: 'Sample Product',
  price: 1499,
  compare_at_price: 1999 as number | null,
  vendor: 'Brand' as string | null,
  product_type: 'Apparel' as string | null,
  imageUrl: null as string | null,
}

type DragKind =
  | { mode: 'move' }
  | { mode: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se' }

interface BoxRect { x: number; y: number; width: number; height: number }

function beginBoxDrag(
  e: React.MouseEvent,
  opts: {
    canvasEl: HTMLDivElement | null
    box: BoxRect
    kind: DragKind
    proportional?: boolean
    onStart?: () => void
    onChange: (updates: Partial<BoxRect>) => void
  }
) {
  e.stopPropagation()
  e.preventDefault()
  opts.onStart?.()
  const { canvasEl, box, kind, proportional, onChange } = opts
  if (!canvasEl) return
  const rect = canvasEl.getBoundingClientRect()
  const startX = e.clientX, startY = e.clientY
  const orig = { ...box }
  const toPctX = (px: number) => (px / rect.width) * 100
  const toPctY = (px: number) => (px / rect.height) * 100
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  function onMove(ev: MouseEvent) {
    const dx = toPctX(ev.clientX - startX)
    const dy = toPctY(ev.clientY - startY)

    if (kind.mode === 'move') {
      onChange({
        x: clamp(orig.x + dx, 0, 100 - orig.width),
        y: clamp(orig.y + dy, 0, 100 - orig.height),
      })
      return
    }

    if (proportional) {
      const aspect = orig.width / orig.height
      const outwardDx = kind.corner.includes('e') ? dx : kind.corner.includes('w') ? -dx : 0
      const maxW = kind.corner.includes('w') ? orig.x + orig.width : 100 - orig.x
      const maxH = kind.corner.includes('n') ? orig.y + orig.height : 100 - orig.y
      let width = clamp(orig.width + outwardDx, 2, Math.min(maxW, maxH * aspect))
      let height = width / aspect
      const x = kind.corner.includes('w') ? orig.x + orig.width - width : orig.x
      const y = kind.corner.includes('n') ? orig.y + orig.height - height : orig.y
      onChange({ x, y, width, height })
      return
    }

    let { x, y, width, height } = orig
    if (kind.corner.includes('e')) width = clamp(orig.width + dx, 2, 100 - orig.x)
    if (kind.corner.includes('s')) height = clamp(orig.height + dy, 2, 100 - orig.y)
    if (kind.corner.includes('w')) {
      width = clamp(orig.width - dx, 2, orig.x + orig.width)
      x = clamp(orig.x + dx, 0, orig.x + orig.width - 2)
    }
    if (kind.corner.includes('n')) {
      height = clamp(orig.height - dy, 2, orig.y + orig.height)
      y = clamp(orig.y + dy, 0, orig.y + orig.height - 2)
    }
    onChange({ x, y, width, height })
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function beginRotate(
  e: React.MouseEvent,
  opts: { canvasEl: HTMLDivElement | null; box: BoxRect; onStart?: () => void; onChange: (deg: number) => void }
) {
  e.stopPropagation()
  e.preventDefault()
  opts.onStart?.()
  const { canvasEl, box, onChange } = opts
  if (!canvasEl) return
  const rect = canvasEl.getBoundingClientRect()
  const cx = rect.left + ((box.x + box.width / 2) / 100) * rect.width
  const cy = rect.top + ((box.y + box.height / 2) / 100) * rect.height
  function onMove(ev: MouseEvent) {
    const deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90
    onChange(Math.round(deg))
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ─── AI Extend Image Layer Preview ───────────────────────────────────────────

function AiExtendImageLayer({
  imageUrl, storeId, targetWidth, targetHeight,
}: {
  imageUrl: string | null
  storeId: string | null
  targetWidth: number
  targetHeight: number
}) {
  const { extendedUrl, loading, error, retry } = useExtendPreview(
    imageUrl, targetWidth, targetHeight, storeId, Boolean(imageUrl && storeId)
  )

  if (loading) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6, background: 'rgba(0,0,0,0.04)' }}>
        <Loader2 style={{ width: 18, height: 18, color: 'var(--primary)', animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 10, color: '#6b7280' }}>AI filling canvas…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8, background: 'rgba(239,68,68,0.05)' }}>
        <Wand2 style={{ width: 14, height: 14, color: '#ef4444' }} />
        <span style={{ fontSize: 10, color: '#ef4444', textAlign: 'center' }}>{error}</span>
        <button onClick={retry} style={{ fontSize: 10, color: '#6b7280', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}>Retry</button>
      </div>
    )
  }
  if (extendedUrl) {
    // Keyed by url so a genuinely different result (new product/dimensions)
    // mounts a fresh instance instead of carrying over stale retry state.
    return <ExtendedResultImage key={extendedUrl} url={extendedUrl} />
  }
  if (imageUrl) {
    return <img src={imageUrl} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', opacity: 0.5 }} />
  }
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9ca3af' }}>
      AI Extend
    </div>
  )
}

// The server only caches/returns extendedUrl once a HEAD request against it
// confirms 200 (see waitForCloudinaryAsset in src/lib/image-extend/index.ts),
// but that check happens from Vercel's region. The browser's own GET to the
// same URL can still land on a different, not-yet-synced Cloudinary CDN edge
// and get a transient 423 — which Chrome reports as "blocked by CORB" for an
// <img> tag (confirmed via DevTools: the blocked resource was this exact
// extend-results/<hash>.jpg file) and then never retries on its own, leaving
// the canvas permanently blank until something forces a brand new <img> load
// (e.g. switching Fit away and back). Retry the load client-side instead of
// waiting on a full remount.
//
// Delays start fast (the edge is often only a few hundred ms behind) and
// back off, so the common case resolves almost immediately instead of
// always waiting out a fixed delay before the first retry.
const EXTENDED_IMAGE_RETRY_DELAYS_MS = [300, 700, 1200, 2000, 3500, 5000]

function ExtendedResultImage({ url }: { url: string }) {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Component is keyed by url at the call site, so a new url always means a
  // fresh mount — no need to reset state here, just clear the timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function handleError() {
    if (attempt >= EXTENDED_IMAGE_RETRY_DELAYS_MS.length) {
      setFailed(true)
      return
    }
    const delay = EXTENDED_IMAGE_RETRY_DELAYS_MS[attempt]
    timerRef.current = setTimeout(() => setAttempt(a => a + 1), delay)
  }

  if (failed) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8, background: 'rgba(239,68,68,0.05)' }}>
        <Wand2 style={{ width: 14, height: 14, color: '#ef4444' }} />
        <span style={{ fontSize: 10, color: '#ef4444', textAlign: 'center' }}>Image still not ready — try again</span>
        <button
          onClick={() => { setAttempt(0); setLoaded(false); setFailed(false) }}
          style={{ fontSize: 10, color: '#6b7280', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Retry
        </button>
      </div>
    )
  }

  // Cache-bust each retry attempt — the browser (and any intermediate CDN
  // cache) must not just hand back its own failed response again.
  const src = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <img
        key={`${url}:${attempt}`}
        src={src}
        alt=""
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={handleError}
        style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
      />
      {/* Shown instead of a blank/broken frame while a CDN-edge retry is in
          flight — most retries resolve within one or two attempts (under a
          second), so this is brief in practice, not a real loading state.
          Must be fully OPAQUE (not the usual faint tint) — this sits on top
          of the actual <img>, and a translucent overlay still lets the
          browser's native broken-image glyph show through underneath it
          for a frame whenever that attempt 423s. */}
      {!loaded && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: '#f3f4f6', pointerEvents: 'none',
        }}>
          <Loader2 style={{ width: 16, height: 16, color: 'var(--primary)', animation: 'spin 1s linear infinite' }} />
        </div>
      )}
    </div>
  )
}

// ─── Local positioning compute ────────────────────────────────────────────────
//
// CHANGED (Product Layer Engine): computeLocalPositioning now accepts
// ProductLayerMetadata in place of ProductBounds when metadata is available.
// calculateSmartFitPlacement() is used when metadata is present; it reads from
// the pre-stored head_y / feet_y / safe_max_upscale instead of recomputing.
// Falls back to calculatePlacement(bounds) for standard mode (no metadata).

interface LocalPositioning {
  apply: boolean
  shotType: ShotType | null
  placement: HeadSpacePlacement | null
  wouldCrop: boolean
  aspectRatio: number | null
  coverageRatio: number | null
}

function computeLocalPositioningFromMetadata(
  metadata: ProductLayerMetadata,
  settings: ProductPositioningSettings,
  canvasW: number,
  canvasH: number
): LocalPositioning {
  if (!settings.enabled || !canvasW || !canvasH) {
    return { apply: false, shotType: null, placement: null, wouldCrop: false, aspectRatio: null, coverageRatio: null }
  }

  const shotType = metadata.shot_type
  const aspectRatio = metadata.product_height_px / Math.max(1, metadata.product_width_px)
  const coverageRatio = (metadata.product_width_px * metadata.product_height_px) /
    (metadata.image_width * metadata.image_height)

  if (!settings.applyToShotTypes.includes(shotType)) {
    return { apply: false, shotType, placement: null, wouldCrop: false, aspectRatio, coverageRatio }
  }

  const { placement, wouldCrop } = calculateSmartFitPlacement(metadata, canvasW, canvasH, settings)
  if (wouldCrop) {
    return { apply: false, shotType, placement: null, wouldCrop: true, aspectRatio, coverageRatio }
  }
  return { apply: true, shotType, placement, wouldCrop: false, aspectRatio, coverageRatio }
}

// Legacy fallback for standard mode (uses ProductBounds, same as before)
function computeLocalPositioningFromBounds(
  bounds: ProductBounds | null,
  settings: ProductPositioningSettings | undefined,
  boxW: number,
  boxH: number
): LocalPositioning | null {
  if (!bounds || !settings?.enabled || !boxW || !boxH) return null
  // Skip degenerate bounds for ALL scale modes.
  // When detectZoomSubjectBounds() can't locate the subject it returns fullImageRect()
  // (bounds.top = 0, bounds.bottom = imageH - 1). Applying framing against bounds we
  // don't trust would either shift the image top to headSpacePx (wrong for smart_fit/fit)
  // or blow up a half-body photo when fill mode mistakes "waist" for "feet".
  // A plain contain-fit is safer and always shows the original image correctly.
  if (isDegenerateBounds(bounds)) {
    return { shotType: null, apply: false, placement: null, wouldCrop: false, aspectRatio: null, coverageRatio: null }
  }
  const signals = computeClassificationSignals(bounds)
  const shotType = classifyShotType(signals)
  const base = { shotType, aspectRatio: signals.aspectRatio, coverageRatio: signals.coverageRatio }
  if (!settings.applyToShotTypes.includes(shotType)) {
    return { ...base, apply: false, placement: null, wouldCrop: false }
  }
  const { placement, wouldCrop } = calculatePlacement(bounds, boxW, boxH, settings)
  if (wouldCrop) return { ...base, apply: false, placement: null, wouldCrop: true }
  return { ...base, apply: true, placement, wouldCrop: false }
}

// ─── Standard mode: Positioned Product Image Layer ───────────────────────────
// Same as before — used in standard mode (no transparent cutout).
// Uses legacy bounds from a separate API call (not the bundle — the bundle
// only runs in ai_product mode).

function PositionedProductImageLayer({
  imageUrl, storeId, positioningSettings, boxPixelW, boxPixelH, fallbackObjectFit,
}: {
  imageUrl: string | null
  storeId: string | null
  positioningSettings: ProductPositioningSettings
  boxPixelW: number
  boxPixelH: number
  fallbackObjectFit: 'cover' | 'contain' | 'fill'
}) {
  // In standard mode, we still need the old bounds-fetch approach since we
  // don't have a transparent cutout. Import the old hook for this path only.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useProductBounds } = require('./use-product-bounds')
  const { bounds } = useProductBounds(imageUrl, storeId, Boolean(imageUrl && storeId))
  const result = computeLocalPositioningFromBounds(bounds, positioningSettings, Math.round(boxPixelW), Math.round(boxPixelH))

  if (!imageUrl) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none' }}>
        Product Image
      </div>
    )
  }

  if (!result?.apply || !result.placement) {
    return <img src={imageUrl} alt="" draggable={false}
      style={{ width: '100%', height: '100%', objectFit: fallbackObjectFit, pointerEvents: 'none' }} />
  }

  const { imgX, imgY, renderedW, renderedH } = result.placement
  const pctX = (v: number) => `${(v / boxPixelW) * 100}%`
  const pctY = (v: number) => `${(v / boxPixelH) * 100}%`

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <img src={imageUrl} alt="" draggable={false} style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'cover', filter: 'blur(20px) saturate(1.1) brightness(0.95)',
        transform: 'scale(1.15)', pointerEvents: 'none',
      }} />
      <img src={imageUrl} alt="" draggable={false} style={{
        position: 'absolute',
        left: pctX(imgX), top: pctY(imgY),
        width: pctX(renderedW), height: pctY(renderedH),
        objectFit: 'fill', pointerEvents: 'none',
      }} />
    </div>
  )
}

// ─── Product Zoom Mode: whole-photo preview ──────────────────────────────────
//
// Mirrors PositionedProductImageLayer's bounds-fetch + calculatePlacement, but
// renders ONLY the sharp positioned image — no blurred backdrop duplicate —
// matching the compositor's product_zoom branch (no separate rendering of
// background + product, ever). Always occupies the full canvas, since the
// original photo IS the canvas content in this mode.

function ProductZoomImageLayer({
  imageUrl, storeId, positioningSettings, canvasW, canvasH,
}: {
  imageUrl: string | null
  storeId: string | null
  positioningSettings: ProductPositioningSettings | undefined
  canvasW: number
  canvasH: number
}) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useProductBounds } = require('./use-product-bounds')
  const { bounds, loading: boundsLoading } = useProductBounds(imageUrl, storeId, Boolean(imageUrl && storeId), 'zoom')
  const result = computeLocalPositioningFromBounds(bounds, positioningSettings, Math.round(canvasW), Math.round(canvasH))
  // Low-confidence detection (backdrop wasn't plain/uniform enough to trust)
  // — bypass Head Space entirely rather than position against bounds that are
  // really just "the whole image," which would reproduce the padding bug.
  const degenerate = Boolean(bounds && isDegenerateBounds(bounds))

  if (!imageUrl) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none' }}>
        Product Image
      </div>
    )
  }

  // While bounds are loading, show the image in contain-fit immediately.
  // Previously returned null here which left the canvas blank for ~1-2 seconds.
  if (boundsLoading) {
    return (
      <img src={imageUrl} alt="" draggable={false} style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'contain', pointerEvents: 'none', opacity: 0.7,
      }} />
    )
  }

  // When positioning is not configured, doesn't apply to this shot type,
  // or would crop — fall back to plain contain-fit. Only truly skip when
  // there's no valid placement at all.
  if (!result?.apply || !result.placement) {
    return (
      <img src={imageUrl} alt="" draggable={false} style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'contain', pointerEvents: 'none',
      }} />
    )
  }

  // computeLocalPositioningFromBounds returns apply:false for degenerate bounds,
  // so when detection failed we fall through to the contain-fit path above.
  // Only proceed here when we have a real detected subject box.

  const { imgX, imgY, renderedW, renderedH } = result.placement
  const pctX = (v: number) => `${(v / canvasW) * 100}%`
  const pctY = (v: number) => `${(v / canvasH) * 100}%`

  return (
    <img src={imageUrl} alt="" draggable={false} style={{
      position: 'absolute',
      left: pctX(imgX), top: pctY(imgY),
      width: pctX(renderedW), height: pctY(renderedH),
      objectFit: 'fill', pointerEvents: 'none',
    }} />
  )
}

// ─── Layer Renderer ───────────────────────────────────────────────────────────

function LayerRenderer({ layer, selected, scaleX, product, canvasEl, onSelect, onChange, positioningSettings, storeId, cW, cH, isAiMode }: {
  layer: Layer
  selected: boolean
  scaleX: number
  product: typeof SAMPLE_PRODUCT
  canvasEl: HTMLDivElement | null
  onSelect: () => void
  onChange: (updates: Partial<Layer>) => void
  positioningSettings: import('@/types/template').ProductPositioningSettings | undefined
  storeId: string | null
  cW: number
  cH: number
  isAiMode: boolean
}) {
  const startDrag = useCallback((e: React.MouseEvent, kind: DragKind) => {
    beginBoxDrag(e, {
      canvasEl,
      box: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      kind,
      onStart: onSelect,
      onChange: (updates) => onChange(updates as Partial<Layer>),
    })
  }, [layer.x, layer.y, layer.width, layer.height, canvasEl, onChange, onSelect])

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${layer.x}%`, top: `${layer.y}%`,
    width: `${layer.width}%`, height: `${layer.height}%`,
    transform: `rotate(${layer.rotation}deg)`,
    opacity: layer.opacity,
    zIndex: layer.zIndex + 1,
    cursor: 'move',
    boxSizing: 'border-box',
    outline: selected ? '2px solid #6366f1' : 'none',
    outlineOffset: '1px',
  }

  const handles = selected ? (['nw', 'ne', 'sw', 'se'] as const).map(c => (
    <div key={c} onMouseDown={(e) => startDrag(e, { mode: 'resize', corner: c })}
      style={{
        position: 'absolute', width: 10, height: 10, background: '#fff',
        border: '2px solid #6366f1', borderRadius: 2, zIndex: 9999,
        cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
        top: c.includes('n') ? -5 : undefined, bottom: c.includes('s') ? -5 : undefined,
        left: c.includes('w') ? -5 : undefined, right: c.includes('e') ? -5 : undefined,
      }} />
  )) : null

  const wrap = (inner: React.ReactNode, extra?: React.CSSProperties) => (
    <div style={{ ...style, ...extra }} onMouseDown={(e) => startDrag(e, { mode: 'move' })}>
      {inner}{handles}
    </div>
  )

  switch (layer.type) {
    case 'rectangle': {
      const l = layer as RectangleLayer
      return wrap(null, {
        backgroundColor: l.backgroundColor, borderRadius: l.borderRadius,
        border: l.borderWidth > 0 ? `${l.borderWidth}px solid ${l.borderColor}` : 'none',
      })
    }
    case 'text': {
      const l = layer as TextLayer
      return wrap(
        <span style={{ pointerEvents: 'none', width: '100%' }}>{resolveVariables(l.content, product)}</span>,
        {
          display: 'flex', alignItems: 'center',
          justifyContent: l.textAlign === 'center' ? 'center' : l.textAlign === 'right' ? 'flex-end' : 'flex-start',
          fontSize: l.fontSize * scaleX, fontFamily: l.fontFamily, fontWeight: l.fontWeight,
          color: l.color, backgroundColor: l.backgroundColor || undefined, borderRadius: l.borderRadius,
          padding: `${l.paddingY * scaleX}px ${l.paddingX * scaleX}px`, textAlign: l.textAlign,
          overflow: 'hidden', lineHeight: 1.2, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }
      )
    }
    case 'image': {
      const l = layer as ImageLayer
      const isProductImage = l.src === '{{product_image}}'
      const realSrc = isProductImage ? product.imageUrl : l.src

      if (!isAiMode && isProductImage && positioningSettings?.enabled && product.imageUrl) {
        const boxPixelW = (layer.width / 100) * cW
        const boxPixelH = (layer.height / 100) * cH
        return wrap(
          <PositionedProductImageLayer
            imageUrl={product.imageUrl} storeId={storeId}
            positioningSettings={positioningSettings}
            boxPixelW={boxPixelW} boxPixelH={boxPixelH}
            fallbackObjectFit={l.objectFit === 'ai_extend' ? 'contain' : l.objectFit}
          />,
          { borderRadius: l.borderRadius, overflow: 'hidden' }
        )
      }

      if (l.objectFit === 'ai_extend' && isProductImage) {
        // cW/cH are the template's own DESIGN dimensions (canvasData.width/
        // height, e.g. 1080×1080) — NOT canvasEl.offsetWidth/Height, which is
        // whatever CSS pixel size the canvas happens to render at on screen.
        // That on-screen size changes with browser window size and zoom, so
        // every resize computed a different cache key and re-ran the ~10-20s
        // Cloudinary generative-fill call from scratch — the preview never
        // reused a previous result and looked stuck/broken far more often
        // than it should. Design dimensions are stable across reloads/resizes
        // and are also what the sibling Head-Space branch above already uses.
        const targetW = Math.round((layer.width / 100) * cW)
        const targetH = Math.round((layer.height / 100) * cH)
        return wrap(
          <AiExtendImageLayer imageUrl={product.imageUrl} storeId={storeId} targetWidth={targetW} targetHeight={targetH} />,
          { borderRadius: l.borderRadius, overflow: 'hidden' }
        )
      }

      return wrap(
        realSrc ? (
          <img src={realSrc} alt="" draggable={false}
            style={{ width: '100%', height: '100%', objectFit: l.objectFit === 'ai_extend' ? 'contain' : l.objectFit, pointerEvents: 'none' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none' }}>
            Product Image
          </div>
        ),
        { borderRadius: l.borderRadius, overflow: 'hidden', backgroundColor: realSrc ? undefined : '#e5e7eb' }
      )
    }
    case 'overlay': {
      const l = layer as OverlayLayer
      return wrap(
        <img src={l.src} alt="" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: l.objectFit, pointerEvents: 'none' }} />,
        { overflow: 'hidden' }
      )
    }
    case 'logo':
    case 'sticker': {
      const l = layer as LogoLayer | StickerLayer
      return wrap(
        l.src ? (
          <img src={l.src} alt="" draggable={false}
            style={{ width: '100%', height: '100%', objectFit: l.objectFit, pointerEvents: 'none' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#9ca3af', pointerEvents: 'none' }}>
            {layer.type === 'sticker' ? 'Sticker' : 'Logo'}
          </div>
        ),
        { borderRadius: l.borderRadius, overflow: 'hidden' }
      )
    }
    case 'badge': {
      const l = layer as BadgeLayer
      return wrap(
        <span style={{ pointerEvents: 'none' }}>{resolveVariables(l.content, product)}</span>,
        {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: l.backgroundColor, color: l.color, fontSize: l.fontSize * scaleX,
          fontWeight: l.fontWeight, borderRadius: l.shape === 'circle' ? '50%' : l.borderRadius,
          overflow: 'hidden', textAlign: 'center',
        }
      )
    }
    default:
      return null
  }
}

// ─── AI Product Layer Preview ─────────────────────────────────────────────────
//
// CHANGED: now receives transparentUrl directly (from the bundle) instead
// of calling useTransparentPreview internally. The bundle fetch is done once
// at the CanvasPreview level and passed down — no duplicate API calls.

function ProductLayerPreview({
  transparentUrl, loading, error, retry, settings, enabled, imageUrl, scaleX,
}: {
  transparentUrl: string | null
  loading: boolean
  error: string | null
  retry: () => void
  settings: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
  enabled: boolean
  imageUrl: string | null
  scaleX: number
}) {
  if (!enabled) return null

  const pad = settings.padding / 100
  const style: React.CSSProperties = {
    position: 'absolute',
    left:   `${settings.x + (settings.width  * pad) / 2}%`,
    top:    `${settings.y + (settings.height * pad) / 2}%`,
    width:  `${settings.width  * (1 - pad)}%`,
    height: `${settings.height * (1 - pad)}%`,
    transform: `rotate(${settings.rotation}deg) scaleX(${settings.flipH ? -1 : 1}) scaleY(${settings.flipV ? -1 : 1})`,
    opacity: settings.opacity,
    zIndex: settings.zIndex + 1,
    pointerEvents: 'none',
  }

  const filters: string[] = []
  if (settings.shadow) {
    filters.push(`drop-shadow(${settings.shadowOffsetX}px ${settings.shadowOffsetY}px ${settings.shadowBlur}px ${settings.shadowColor})`)
  }
  if (settings.glow) {
    filters.push(`drop-shadow(0 0 ${settings.glowBlur}px ${settings.glowColor})`)
  }

  if (!imageUrl) {
    return (
      <div style={style} className="flex items-center justify-center bg-muted/40 rounded-lg border border-dashed">
        <p className="text-xs text-muted-foreground px-2 text-center">Select a preview product to see the AI result</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={style} className="flex flex-col items-center justify-center gap-2 bg-muted/40 rounded-lg">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground">Preparing product layer…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={style} className="flex flex-col items-center justify-center gap-1.5 bg-destructive/5 rounded-lg border border-destructive/30 p-2">
        <p className="text-xs text-destructive text-center">{error}</p>
        <button onClick={retry} className="text-xs underline text-muted-foreground">Retry</button>
      </div>
    )
  }

  if (!transparentUrl) return null

  return (
    <img
      src={transparentUrl}
      alt="Product (background removed)"
      draggable={false}
      style={{ ...style, objectFit: settings.objectFit, filter: filters.length > 0 ? filters.join(' ') : undefined }}
    />
  )
}

// ─── AiModePositioning ────────────────────────────────────────────────────────
//
// CHANGED (Product Layer Engine):
//  - Receives the bundle state from the parent instead of calling its own hooks
//  - Uses metadata from the bundle for instant local Head Space computation
//    via computeLocalPositioningFromMetadata() — zero API calls while dragging
//  - Backgrounds are now rendered at the CanvasPreview level from backgroundUrl

function AiModePositioning({
  imageUrl, storeId, enabled, settings, positioningSettings, scaleX, canvasW, canvasH, canvasEl,
  // NEW: bundle state passed from CanvasPreview
  bundle,
}: {
  imageUrl: string | null
  storeId: string | null
  enabled: boolean
  settings: typeof DEFAULT_PRODUCT_LAYER_SETTINGS
  positioningSettings: ProductPositioningSettings | undefined
  scaleX: number
  canvasW: number
  canvasH: number
  canvasEl: HTMLDivElement | null
  bundle: ReturnType<typeof useProductLayerBundle>
}) {
  const { selectedLayerId, selectLayer, setProductLayerSettings } = useBuilderStore()

  const positioningOn = Boolean(positioningSettings?.enabled)
  const manualMode = enabled && !positioningOn
  const selected = selectedLayerId === PRODUCT_LAYER_ID
  const locked = Boolean(settings.locked)
  const interactive = manualMode && !locked && Boolean(imageUrl)

  // CHANGED: compute placement from metadata (zero network calls) when available
  // Falls back to null (no repositioning) when metadata hasn't loaded yet
  const result: ReturnType<typeof computeLocalPositioningFromMetadata> | null =
    (positioningSettings?.enabled && bundle.metadata)
      ? computeLocalPositioningFromMetadata(bundle.metadata, positioningSettings, canvasW, canvasH)
      : null

  const effectiveSettings = (result?.apply && result.placement)
    ? placementToProductLayerSettings(result.placement, canvasW, canvasH, settings)
    : settings

  const SHOT_LABELS: Record<ShotType, string> = {
    full_body: 'Full Body', half_body: 'Half Body', close_up: 'Close-up',
    detail: 'Detail', flat_lay: 'Flat Lay', accessory: 'Accessory',
  }

  const contentBox = (result?.apply && result.placement && bundle.metadata) ? (() => {
    const m = bundle.metadata!
    const p = result.placement!
    // Reconstruct content box from stored metadata bbox
    const bounds = { left: m.bbox.left, top: m.bbox.top, right: m.bbox.right, bottom: m.bbox.bottom }
    return {
      left:   ((p.imgX + bounds.left * p.scale) / canvasW) * 100,
      top:    ((p.imgY + bounds.top  * p.scale) / canvasH) * 100,
      width:  (((bounds.right - bounds.left) * p.scale) / canvasW) * 100,
      height: (((bounds.bottom - bounds.top) * p.scale) / canvasH) * 100,
    }
  })() : null

  const box: BoxRect = { x: settings.x, y: settings.y, width: settings.width, height: settings.height }

  function autoArrange() {
    if (!bundle.metadata) return
    const { placement, wouldCrop } = calculateSmartFitPlacement(
      bundle.metadata,
      canvasW,
      canvasH,
      positioningSettings ?? {
        headSpacePx: 120, leftMarginPx: 0, rightMarginPx: 0, bottomMarginPx: 0,
        autoCenterHorizontally: true, scaleMode: 'smart_fit', maxUpscale: 1.5,
      } as ProductPositioningSettings
    )
    if (wouldCrop) return
    setProductLayerSettings(placementToProductLayerSettings(placement, canvasW, canvasH, settings))
  }

  return (
    <>
      <ProductLayerPreview
        transparentUrl={bundle.transparentUrl}
        loading={bundle.loading}
        error={bundle.error}
        retry={bundle.retry}
        settings={effectiveSettings}
        enabled={enabled}
        imageUrl={imageUrl}
        scaleX={scaleX}
      />

      {interactive && (
        <div
          onMouseDown={(e) => beginBoxDrag(e, {
            canvasEl, box, kind: { mode: 'move' },
            onStart: () => selectLayer(PRODUCT_LAYER_ID),
            onChange: (u) => setProductLayerSettings(u),
          })}
          style={{
            position: 'absolute',
            left: `${settings.x}%`, top: `${settings.y}%`,
            width: `${settings.width}%`, height: `${settings.height}%`,
            transform: `rotate(${settings.rotation}deg)`,
            zIndex: settings.zIndex + 2, cursor: 'move',
            outline: selected ? '2px solid #6366f1' : '1px dashed rgba(99,102,241,0.5)',
            outlineOffset: 1, background: 'transparent',
          }}
        >
          {selected && (['nw', 'ne', 'sw', 'se'] as const).map(c => (
            <div key={c} onMouseDown={(e) => beginBoxDrag(e, {
              canvasEl, box, kind: { mode: 'resize', corner: c }, proportional: true,
              onChange: (u) => setProductLayerSettings(u),
            })}
              style={{
                position: 'absolute', width: 10, height: 10, background: '#fff',
                border: '2px solid #6366f1', borderRadius: 2, zIndex: 10000,
                cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
                top: c.includes('n') ? -5 : undefined, bottom: c.includes('s') ? -5 : undefined,
                left: c.includes('w') ? -5 : undefined, right: c.includes('e') ? -5 : undefined,
              }} />
          ))}
          {selected && (
            <div
              onMouseDown={(e) => beginRotate(e, { canvasEl, box, onChange: (deg) => setProductLayerSettings({ rotation: deg }) })}
              style={{
                position: 'absolute', top: -24, left: '50%', width: 12, height: 12,
                marginLeft: -6, background: '#fff', border: '2px solid #6366f1',
                borderRadius: '50%', cursor: 'grab', zIndex: 10000,
              }}
              title="Rotate"
            />
          )}
        </div>
      )}

      {manualMode && selected && (
        <div
          style={{
            position: 'absolute', left: `${settings.x}%`, top: `calc(${settings.y}% - 34px)`,
            zIndex: 10001, display: 'flex', gap: 4, padding: 4,
            background: 'rgba(255,255,255,0.96)', borderRadius: 8,
            border: '1px solid rgba(0,0,0,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            whiteSpace: 'nowrap',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Auto-arrange uses stored metadata — instant, no API call */}
          <ToolbarButton label="✨ Auto-arrange" onClick={autoArrange} disabled={!bundle.metadata} primary />
          <ToolbarButton label="Flip H" active={settings.flipH} onClick={() => setProductLayerSettings({ flipH: !settings.flipH })} />
          <ToolbarButton label="Flip V" active={settings.flipV} onClick={() => setProductLayerSettings({ flipV: !settings.flipV })} />
          <ToolbarButton label={locked ? '🔒' : '🔓'} onClick={() => setProductLayerSettings({ locked: !locked })} />
        </div>
      )}

      {manualMode && locked && (
        <div
          onMouseDown={(e) => { e.stopPropagation(); selectLayer(PRODUCT_LAYER_ID) }}
          style={{
            position: 'absolute', left: `${settings.x}%`, top: `${settings.y}%`,
            width: `${settings.width}%`, height: `${settings.height}%`,
            zIndex: settings.zIndex + 2, cursor: 'pointer',
            outline: selected ? '2px solid #6366f1' : 'none',
          }}
        />
      )}

      {positioningOn && positioningSettings?.showGuide && contentBox && (
        <div
          style={{
            position: 'absolute',
            left: `${contentBox.left}%`, top: `${contentBox.top}%`,
            width: `${contentBox.width}%`, height: `${contentBox.height}%`,
            border: '1px dashed rgba(16, 185, 129, 0.8)', zIndex: 9998, pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
      )}

      {positioningOn && (
        <div style={{
          position: 'absolute', left: 6, bottom: 6, zIndex: 9999,
          fontSize: 10, lineHeight: 1.3,
          background: 'rgba(255,255,255,0.88)', color: '#111', padding: '2px 8px',
          borderRadius: 999, pointerEvents: 'none', border: '1px solid rgba(0,0,0,0.08)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.12)', whiteSpace: 'nowrap',
        }}>
          {bundle.error
            ? <span style={{ color: '#dc2626' }}>Detection failed — using manual layout</span>
            : bundle.loading
              ? 'Loading product layer…'
              : !bundle.metadata
                ? 'Detecting product…'
                : result?.apply
                  ? <>Detected: <b>{bundle.metadata.shot_type.replace('_', ' ')}</b> · Smart Fit 2.0</>
                  : <>Detected: <b>{bundle.metadata.shot_type.replace('_', ' ')}</b> · skipped</>}
        </div>
      )}
    </>
  )
}

function ToolbarButton({ label, onClick, active, primary, disabled }: {
  label: string; onClick: () => void; active?: boolean; primary?: boolean; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      style={{
        fontSize: 11, lineHeight: 1, padding: '5px 8px', borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        border: '1px solid ' + (active ? '#6366f1' : 'rgba(0,0,0,0.12)'),
        background: primary ? '#6366f1' : active ? 'rgba(99,102,241,0.1)' : '#fff',
        color: primary ? '#fff' : active ? '#4f46e5' : '#111',
        opacity: disabled ? 0.5 : 1, fontWeight: 500,
      }}
    >
      {label}
    </button>
  )
}

// ─── Canvas Preview ───────────────────────────────────────────────────────────

export function CanvasPreview({ storeId }: { storeId?: string | null } = {}) {
  const { canvasData, selectedLayerId, selectLayer, updateLayer, previewProduct } = useBuilderStore()
  const canvasRef = useRef<HTMLDivElement>(null)
  const product = previewProduct ?? SAMPLE_PRODUCT

  const { width: cW, height: cH } = canvasData
  const scale = Math.min(MAX_W / cW, MAX_H / cH, 1)
  const displayW = Math.round(cW * scale)
  const displayH = Math.round(cH * scale)
  const scaleX = displayW / 1000

  const isAiMode = canvasData.templateMode === 'ai_product'
  const isZoomMode = canvasData.templateMode === 'product_zoom'
  const productLayerSettings = canvasData.productLayerSettings ?? DEFAULT_PRODUCT_LAYER_SETTINGS

  const bgSettings = canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS

  // CHANGED: single bundle hook replaces three separate hooks
  // useTransparentPreview + useProductBounds + useBackgroundReconstructionPreview
  const bundle = useProductLayerBundle(
    product.imageUrl,
    storeId ?? null,
    isAiMode  // only fetch in AI product mode
  )

  const sampleSrc = (() => {
    if (bgSettings.mode === 'solid' || bgSettings.mode === 'transparent') return null
    if (isAiMode || isZoomMode) return null
    if (product.imageUrl) return product.imageUrl
    const imgLayer = canvasData.layers.find(
      l => (l.type === 'image' || l.type === 'overlay') &&
        (l as any).src && (l as any).src !== '{{product_image}}'
    )
    return imgLayer ? (imgLayer as any).src : null
  })()

  const { backgroundImageCss } = useSmartBackground({
    mode: bgSettings.mode,
    imageSrc: sampleSrc,
    canvasWidth: displayW,
    canvasHeight: displayH,
    settings: bgSettings,
    solidColor: canvasData.backgroundColor,
  })

  // CHANGED: 'original' mode background now comes from bundle.backgroundUrl
  // (the pre-computed Background Plate) instead of a separate reconstruction call.
  // This is instant after the first bundle fetch — no extra AI call.
  const useOriginalBackground = isAiMode && bgSettings.mode === 'original'
  const backgroundPlateUrl = useOriginalBackground ? bundle.backgroundUrl : null

  const transparentBg = bgSettings.mode === 'transparent'
    ? 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 0 / 16px 16px'
    : undefined

  const isRawProductImageLayer = (l: Layer) =>
    l.type === 'image' && (l as any).src === '{{product_image}}'

  const sortedLayers = [...canvasData.layers]
    .filter(l => !((isAiMode || isZoomMode) && isRawProductImageLayer(l)))
    .sort((a, b) => a.zIndex - b.zIndex)
  const bgLayers = isAiMode
    ? sortedLayers.filter(l => l.zIndex < productLayerSettings.zIndex)
    : sortedLayers
  const fgLayers = isAiMode
    ? sortedLayers.filter(l => l.zIndex >= productLayerSettings.zIndex)
    : []

  function renderLayer(layer: Layer) {
    return (
      <LayerRenderer
        key={layer.id}
        layer={layer}
        product={product}
        canvasEl={canvasRef.current}
        scaleX={scaleX}
        selected={selectedLayerId === layer.id}
        onSelect={() => selectLayer(layer.id)}
        onChange={(updates) => updateLayer(layer.id, updates)}
        positioningSettings={canvasData.productPositioningSettings}
        storeId={storeId ?? null}
        cW={cW}
        cH={cH}
        isAiMode={isAiMode}
      />
    )
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{cW} × {cH}px</span>
        {isAiMode && (
          <span className="flex items-center gap-1 text-xs text-primary font-medium">
            <Sparkles className="h-3 w-3" />
            Live AI preview
          </span>
        )}
        {/* Background plate status — shown whenever we're in AI mode so the user
            knows the Original Background option is available (or loading).
            Shows regardless of which background mode is currently selected. */}
        {isAiMode && bundle.loading && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading background plate…
          </span>
        )}
        {isAiMode && !bundle.loading && bundle.backgroundUrl && (
          <span className="text-xs" style={{ color: '#16a34a' }}>
            Background plate: ready
          </span>
        )}
        {isAiMode && !bundle.loading && !bundle.backgroundUrl && !bundle.error && bundle.transparentUrl && (
          <button
            type="button"
            onClick={() => bundle.retry()}
            className="text-xs underline"
            style={{ color: '#d97706', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            Background plate unavailable — Retry
          </button>
        )}
        {isAiMode && bundle.error && (
          <span className="text-xs" style={{ color: '#dc2626' }}>
            {bundle.error}
          </span>
        )}
      </div>
      <div
        ref={(el) => {
          (canvasRef as any).current = el
          if (el) (el as any).__storeId = storeId ?? null
        }}
        style={{
          width: displayW, height: displayH,
          // Product Zoom mode always solid-fills — the compositor's product_zoom
          // branch never reads backgroundSettings.mode/backgroundImageUrl, so the
          // preview must match by ignoring them here too.
          backgroundColor: isZoomMode
            ? canvasData.backgroundColor
            : (bgSettings.mode === 'transparent' ? 'transparent' : canvasData.backgroundColor),
          // For 'original' mode we render the background plate as a positioned <img>
          // child element (see below) instead of CSS backgroundImage.
          // This avoids CSS url() parsing issues with Cloudinary URLs that contain
          // parentheses (e.g., gen_remove:region_((x_;y_;w_;h_)) in the path).
          backgroundImage: isZoomMode
            ? undefined
            : useOriginalBackground
              ? undefined  // handled by the <img> child below
              : (backgroundImageCss ?? (transparentBg ?? (canvasData.backgroundImageUrl ? `url("${canvasData.backgroundImageUrl}")` : undefined))),
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative', overflow: 'hidden', flexShrink: 0,
          boxShadow: '0 4px 32px rgba(0,0,0,0.12)', borderRadius: 6, userSelect: 'none',
        }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) selectLayer(null) }}
      >
        {/* ── Background Plate (Original Background mode) ──────────────────────
            Rendered as a positioned <img> instead of CSS backgroundImage so that
            Cloudinary URLs with special characters (parentheses in gen_remove
            transformation strings) are handled correctly by the browser.
            Sits at z-index 0 behind all layers. */}
        {useOriginalBackground && backgroundPlateUrl && (
          <img
            src={backgroundPlateUrl}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
              zIndex: 0,
              pointerEvents: 'none',
            }}
          />
        )}
        {/* Fallback: while background plate is loading in 'original' mode,
            show a subtle loading shimmer so the user knows it's coming */}
        {useOriginalBackground && !backgroundPlateUrl && bundle.loading && (
          <div
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
              backgroundSize: '200% 100%',
              animation: 'shimmer 1.5s infinite',
              pointerEvents: 'none',
            }}
          />
        )}
        {/* Terminal partial failure: background plate generation failed server-side
            (bundleStatus === 'partial', no error thrown). Distinct from the loading
            shimmer above — this state does not resolve on its own, so surface a
            retry instead of silently rendering nothing (which was indistinguishable
            from "still loading"). */}
        {useOriginalBackground && !backgroundPlateUrl && !bundle.loading && !bundle.error && bundle.transparentUrl && (
          <div
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <button
              type="button"
              onClick={() => bundle.retry()}
              style={{
                pointerEvents: 'auto', fontSize: 12, color: '#d97706',
                textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer',
              }}
            >
              Background unavailable — Retry
            </button>
          </div>
        )}
        {isZoomMode && (
          <ProductZoomImageLayer
            imageUrl={product.imageUrl}
            storeId={storeId ?? null}
            positioningSettings={canvasData.productPositioningSettings}
            canvasW={cW}
            canvasH={cH}
          />
        )}
        {bgLayers.map(renderLayer)}
        {isAiMode && (
          <AiModePositioning
            imageUrl={product.imageUrl}
            storeId={storeId ?? null}
            enabled={isAiMode}
            settings={productLayerSettings}
            positioningSettings={canvasData.productPositioningSettings}
            scaleX={scaleX}
            canvasW={cW}
            canvasH={cH}
            canvasEl={canvasRef.current}
            bundle={bundle}
          />
        )}
        {fgLayers.map(renderLayer)}
        {canvasData.productPositioningSettings?.enabled && (
          <ProductPositioningGuide
            settings={canvasData.productPositioningSettings}
            displayW={displayW}
            displayH={displayH}
            canvasW={cW}
            canvasH={cH}
          />
        )}
      </div>
    </div>
  )
}