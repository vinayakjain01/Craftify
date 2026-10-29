'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Wand2, Download, Trash2, RefreshCw, ImageIcon, Loader2, StopCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { DownloadZipButton } from './download-zip-button'
import { shopifyFetch } from '@/lib/shopify-token'
import { cn } from '@/lib/utils'
import { ALL_ASSET_TYPES, ASSET_TYPE_CONFIG, type AssetType } from '@/types/template'

interface Creative {
  id: string
  url: string
  created_at: string
  template_id: string
  cloudinary_id: string | null
  variant_id: string | null
  asset_type: AssetType | null
  products: { title: string } | null
  product_variants: { title: string | null; option1: string | null; option2: string | null; option3: string | null } | null
  templates: { name: string } | null
}

interface BatchCounts {
  pending: number
  processing: number
  completed: number
  failed: number
  cancelled: number
  /** No rule matched this job's product — not an error, just nothing to render. */
  skipped: number
  total: number
}

interface GenerationEstimate {
  count: number
  variants: number
  products: number
  overLimit: boolean
  softWarn: boolean
  limit: number
  softWarnThreshold: number
}

/** Shown as suggestions before the store's own option names have loaded (or
 *  for a store with none recorded yet — see /api/products/option-names). */
const DEFAULT_OPTION_NAME_SUGGESTIONS = ['Size', 'Colour', 'Material', 'Style']

/** "Red / M" from a variant's title, or its raw options if the title is unset. */
function variantLabel(v: Creative['product_variants']): string | null {
  if (!v) return null
  if (v.title && v.title !== 'Default Title') return v.title
  const opts = [v.option1, v.option2, v.option3].filter(Boolean)
  return opts.length ? opts.join(' / ') : null
}

export function CreativesClient({ stores }: { stores: { id: string; shop_name: string; shop_domain: string }[] }) {
  const [selectedStore, setSelectedStore] = useState(stores[0]?.id || '')
  const [creatives, setCreatives] = useState<Creative[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [genResult, setGenResult] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchCounts | null>(null)
  const [page, setPage] = useState(0)
  const [totalCreatives, setTotalCreatives] = useState(0)

  // ── Generate Scope ─────────────────────────────────────────────────────────
  const [variantScope, setVariantScope] = useState<'all' | 'specific'>('all')
  const [variantOptionName, setVariantOptionName] = useState('')
  const [variantOptionValue, setVariantOptionValue] = useState('')
  // Defaults to 'first': generating every pose for every variant is the
  // expensive, deliberate choice (up to several jobs per variant), so the
  // page shouldn't pre-select it — a merchant who wants "All poses" now has
  // to opt into it explicitly.
  const [imageScope, setImageScope] = useState<'all' | 'first'>('first')
  const [optionNameSuggestions, setOptionNameSuggestions] = useState<string[]>([])
  const [estimate, setEstimate] = useState<GenerationEstimate | null>(null)
  const [estimateLoading, setEstimateLoading] = useState(false)

  // Which placement to generate for — a merchant can select several at once
  // (one job per variant/image PER selected type). Catalog only by default,
  // matching every other default in this scope.
  const [selectedGenerateTypes, setSelectedGenerateTypes] = useState<AssetType[]>(['catalog'])
  function toggleGenerateType(type: AssetType) {
    setSelectedGenerateTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    )
  }

  // Which placement's creatives the grid below is showing — independent of
  // what's selected to generate.
  const [selectedAssetType, setSelectedAssetType] = useState<AssetType>('catalog')

  const currentBatchId = useRef<string | null>(null)
  const pollingActive = useRef(false)
  const lastCompletedAt = useRef<{ count: number; time: number }>({ count: 0, time: Date.now() })

  // 12 divides evenly by the grid's 2/3/4-column breakpoints, so the last row
  // is never a ragged partial row the way 10 was at the 4-column breakpoint.
  const PER_PAGE = 12

  // Plain function, not useCallback: it's invoked imperatively from event
  // handlers (Refresh, post-delete, the generation-progress poll), which is
  // fine. The REACTIVE load below inlines the same query instead of calling
  // this, because `useEffect(() => { fetchCreatives() }, [fetchCreatives])`
  // trips the set-state-in-effect lint rule on the setState calls inside it —
  // the same reason rules-client.tsx's load effect is written this way.
  async function fetchCreatives() {
    if (!selectedStore) return
    setLoading(true)
    const supabase = (await import('@/lib/supabase/client')).createClient()
    const fromRow = page * PER_PAGE
    // generated_creatives (v2) carries store_id directly — a plain filter, no
    // join through products — and one row survives per (variant, image,
    // template, asset_type) instead of the legacy table's one row per
    // (product, template). Scoped to the placement tab currently selected —
    // 'catalog' by default so what merchants see first here is the same set
    // the Meta feed actually reads from.
    const { data, count } = await supabase
      .from('generated_creatives')
      .select(`
        id, url, created_at, template_id, cloudinary_id, variant_id, asset_type,
        products(title),
        product_variants(title, option1, option2, option3),
        templates(name)
      `, { count: 'exact' })
      .eq('store_id', selectedStore)
      .eq('asset_type', selectedAssetType)
      .order('created_at', { ascending: false })
      .range(fromRow, fromRow + PER_PAGE - 1)
    setCreatives((data as any) || [])
    setTotalCreatives(count || 0)
    setLoading(false)
  }

  // Switching stores or placement tabs both re-page: "page 3 of Story" isn't a
  // meaningful position once Catalog's own page count may differ entirely.
  useEffect(() => {
    if (selectedStore) setPage(0)
  }, [selectedStore, selectedAssetType])

  // Reactive load on store/page/asset-type change. Inlined + cancellation-guarded
  // rather than calling fetchCreatives(), so a slow response for a selection the
  // user has since switched away from cannot overwrite the newer one's data.
  useEffect(() => {
    if (!selectedStore) return
    let cancelled = false

    ;(async () => {
      setLoading(true)
      const supabase = (await import('@/lib/supabase/client')).createClient()
      const fromRow = page * PER_PAGE
      const { data, count } = await supabase
        .from('generated_creatives')
        .select(`
          id, url, created_at, template_id, cloudinary_id, variant_id, asset_type,
          products(title),
          product_variants(title, option1, option2, option3),
          templates(name)
        `, { count: 'exact' })
        .eq('store_id', selectedStore)
        .eq('asset_type', selectedAssetType)
        .order('created_at', { ascending: false })
        .range(fromRow, fromRow + PER_PAGE - 1)

      if (cancelled) return
      setCreatives((data as any) || [])
      setTotalCreatives(count || 0)
      setLoading(false)
    })()

    return () => { cancelled = true }
  }, [selectedStore, page, selectedAssetType])

  // Suggestions for the Option name field — best-effort; an empty/failed
  // response just leaves the four common defaults, never blocks the form.
  useEffect(() => {
    if (!selectedStore) return
    let cancelled = false
    shopifyFetch(`/api/products/option-names?storeId=${selectedStore}`)
      .then(res => res.json())
      .then(data => { if (!cancelled && Array.isArray(data.names)) setOptionNameSuggestions(data.names) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedStore])

  // Live "will generate: N jobs" preview — debounced so switching options
  // rapidly doesn't fire one request per keystroke. All setState calls happen
  // inside the timer/promise callbacks (never synchronously in the effect
  // body itself), matching the pattern already established for the load
  // effects above — a synchronous set-state directly in an effect body is
  // rejected by the React Compiler lint rule.
  useEffect(() => {
    if (!selectedStore) return
    let cancelled = false

    const timer = setTimeout(() => {
      if (cancelled) return

      const scopeIncomplete =
        (variantScope === 'specific' && (!variantOptionName.trim() || !variantOptionValue.trim())) ||
        selectedGenerateTypes.length === 0

      if (scopeIncomplete) {
        setEstimate(null)
        setEstimateLoading(false)
        return
      }

      setEstimateLoading(true)
      const params = new URLSearchParams({
        storeId: selectedStore, variantScope, imageScope,
        assetTypes: selectedGenerateTypes.join(','),
      })
      if (variantScope === 'specific') {
        params.set('optionName', variantOptionName.trim())
        params.set('optionValue', variantOptionValue.trim())
      }

      shopifyFetch(`/api/generate/estimate?${params.toString()}`)
        .then(async res => {
          const data = await res.json()
          if (cancelled) return
          setEstimate(res.ok ? data : null)
          setEstimateLoading(false)
        })
        .catch(() => {
          if (!cancelled) { setEstimate(null); setEstimateLoading(false) }
        })
    }, 450)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [selectedStore, variantScope, variantOptionName, variantOptionValue, imageScope, selectedGenerateTypes])

  function handleVariantScopeChange(v: string) {
    setVariantScope(v as 'all' | 'specific')
    setVariantOptionName('')
    setVariantOptionValue('')
  }

  async function handleGenerate() {
    setGenerating(true)
    setStopping(false)
    setGenResult(null)
    setBatchProgress(null)
    currentBatchId.current = null
    pollingActive.current = true
    lastCompletedAt.current = { count: 0, time: Date.now() }

    const res = await shopifyFetch('/api/generate/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        storeId: selectedStore,
        filter: { type: 'all' },
        variantScope,
        variantOption: variantScope === 'specific'
          ? { name: variantOptionName.trim(), value: variantOptionValue.trim() }
          : null,
        imageScope,
        assetTypes: selectedGenerateTypes,
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setGenResult(data.error || 'Generation failed')
      setGenerating(false)
      pollingActive.current = false
      return
    }

    if (!data.enqueued) {
      setGenResult(data.message || 'No products matched the rules.')
      setGenerating(false)
      pollingActive.current = false
      return
    }

    const batchId: string = data.batchId
    currentBatchId.current = batchId
    setGenResult(`Queued ${data.enqueued} jobs — worker is processing…`)

    // Progress polling loop
    const tick = async (): Promise<void> => {
      if (!pollingActive.current) return
      try {
        const pr = await shopifyFetch(`/api/generate/enqueue?batchId=${batchId}`)
        const c: BatchCounts = await pr.json()
        setBatchProgress(c)

        // 'skipped' (no matching rule for the job's product) is a terminal
        // status, same as completed/failed/cancelled — leaving it out here
        // made the loop poll forever once any job hit it, since done never
        // reached total.
        const done = (c.completed || 0) + (c.failed || 0) + (c.cancelled || 0) + (c.skipped || 0)

        if (c.completed > lastCompletedAt.current.count) {
          lastCompletedAt.current = { count: c.completed, time: Date.now() }
        }

        if (c.cancelled > 0 && (c.pending + c.processing) === 0) {
          setGenResult(`Stopped. ${c.completed} completed, ${c.cancelled} cancelled.`)
          fetchCreatives()
          setGenerating(false)
          pollingActive.current = false
          return
        }

        if (c.total > 0 && done >= c.total) {
          setGenResult(
            `Done. ${c.completed} created` +
            (c.failed ? `, ${c.failed} failed` : '') +
            (c.skipped ? `, ${c.skipped} skipped (no matching rule)` : '') +
            '.'
          )
          fetchCreatives()
          setGenerating(false)
          pollingActive.current = false
          return
        }

        setGenResult(`Generating… ${done}/${c.total} done`)
        fetchCreatives()
        setTimeout(tick, 2000)
      } catch {
        setTimeout(tick, 3000)
      }
    }
    tick()
  }

  async function handleStop() {
    if (!currentBatchId.current || !selectedStore) return
    setStopping(true)
    pollingActive.current = false
    try {
      const res = await shopifyFetch('/api/generate/cancel', {
        method: 'POST',
        body: JSON.stringify({ storeId: selectedStore, batchId: currentBatchId.current }),
      })
      const data = await res.json()
      // /api/generate/cancel now deletes pending rows outright rather than
      // soft-cancelling them, so the response reports both counts separately.
      const total = (data.deleted ?? 0) + (data.cancelled ?? 0)
      setGenResult(res.ok
        ? `Stopped. ${total} jobs removed (${data.deleted ?? 0} deleted, ${data.cancelled ?? 0} in progress cancelled).`
        : `Stop failed: ${data.error}`)
    } catch (err: any) {
      setGenResult(`Stop error: ${err.message}`)
    }
    setStopping(false)
    setGenerating(false)
    fetchCreatives()
  }

  async function handleDelete(creativeId: string) {
    if (!confirm('Delete this creative?')) return
    await shopifyFetch(`/api/creatives/${creativeId}`, { method: 'DELETE' })
    setCreatives(prev => prev.filter(c => c.id !== creativeId))
  }

  if (stores.length === 0) {
    return <p className="text-muted-foreground">No stores connected.</p>
  }

  const progressPercent = batchProgress && batchProgress.total > 0
    ? Math.round(((batchProgress.completed + batchProgress.failed + batchProgress.cancelled + batchProgress.skipped) / batchProgress.total) * 100)
    : 0

  const generateDisabled =
    generating ||
    (variantScope === 'specific' && (!variantOptionName.trim() || !variantOptionValue.trim())) ||
    selectedGenerateTypes.length === 0 ||
    Boolean(estimate?.overLimit)

  const scopeSummary = buildScopeSummary({
    variantScope, variantOptionName, variantOptionValue, imageScope,
  })

  return (
    <div className="space-y-6">
      {/* ── Generate Scope ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Row 1: Variants */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm font-medium">Variants</span>
            <Select value={variantScope} onValueChange={handleVariantScopeChange}>
              <SelectTrigger className="flex-1 *:data-[slot=select-value]:min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                {/* Label and description sit in ONE row, not stacked: Radix
                    mirrors an item's children verbatim into the closed
                    trigger, so whatever layout is used here is also what the
                    collapsed dropdown shows — a stacked pair would centre two
                    lines in the trigger instead of reading as a single control. */}
                <SelectItem value="all">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">All variants</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Every size, colour, and option for each product
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="specific">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">Specific option…</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Choose one option value (e.g. Size: M) across all products
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Sub-row: option name + value — Option name is free text with
              suggestions, not a closed Select: there is no fixed list of
              option names across a whole store (a store can name it "Size",
              "Taille", or anything else), so a dropdown would either miss
              real values or need per-store data the merchant can't predict. */}
          {variantScope === 'specific' && (
            <div className="ml-[76px] space-y-1.5">
              <div className="flex items-center gap-2">
                <Input
                  list="option-name-suggestions"
                  className="w-40"
                  placeholder="Option name"
                  value={variantOptionName}
                  onChange={e => setVariantOptionName(e.target.value)}
                />
                <datalist id="option-name-suggestions">
                  {Array.from(new Set([...optionNameSuggestions, ...DEFAULT_OPTION_NAME_SUGGESTIONS])).map(n => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                <span className="text-sm text-muted-foreground">=</span>
                <Input
                  className="flex-1"
                  placeholder="e.g. M, Red, XL"
                  value={variantOptionValue}
                  onChange={e => setVariantOptionValue(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Only generate for variants where{' '}
                <strong>{variantOptionName || 'option'}</strong> is{' '}
                <strong>{variantOptionValue || '…'}</strong>
              </p>
              {(!variantOptionName.trim() || !variantOptionValue.trim()) && (
                <p className="text-xs text-destructive">
                  Fill in both the option name and value above to enable &quot;Generate creatives&quot;.
                </p>
              )}
            </div>
          )}

          {/* Row 2: Images */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm font-medium">Images</span>
            <Select value={imageScope} onValueChange={v => setImageScope(v as 'all' | 'first')}>
              <SelectTrigger className="flex-1 *:data-[slot=select-value]:min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">All poses</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Every image for each variant — angles, detail shots, lifestyle
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="first">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium shrink-0">First pose only</span>
                    <span className="truncate text-xs text-muted-foreground">
                      Only the primary / first image for each variant
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Row 3: which placement(s) to generate — independent of imageScope/
              variantScope, this multiplies the fan-out again: one job per
              variant × image × selected asset type. Generate/Stop sit right
              after the pills, in the same wrapping row, rather than pinned to
              the card's far edge — the action stays visually attached to the
              choice that shapes it instead of floating off on its own. */}
          <div className="flex items-start gap-3">
            <span className="w-16 shrink-0 pt-1.5 text-sm font-medium">Generate for</span>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {ALL_ASSET_TYPES.map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleGenerateType(type)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                      selectedGenerateTypes.includes(type)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:border-primary/50'
                    )}
                  >
                    {ASSET_TYPE_CONFIG[type].label}
                    <span className="ml-1 text-xs opacity-70">{ASSET_TYPE_CONFIG[type].aspectRatio}</span>
                  </button>
                ))}

                <Button className="ml-2" onClick={handleGenerate} disabled={generateDisabled}>
                  {generating
                    ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating…</>
                    : <><Wand2 className="h-4 w-4 mr-2" />Generate creatives</>
                  }
                </Button>
                {generating && (
                  <Button
                    variant="outline"
                    onClick={handleStop}
                    disabled={stopping}
                    className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  >
                    {stopping
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Stopping…</>
                      : <><StopCircle className="h-4 w-4 mr-2" />Stop</>
                    }
                  </Button>
                )}
              </div>
              {selectedGenerateTypes.length === 0 ? (
                <p className="text-xs text-destructive">
                  Select at least one placement above to enable &quot;Generate creatives&quot;.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Catalog → Meta Commerce feed · Feed/Story/Reel → ad placements, never shown in the feed
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Both lines live inside one -mt-3 wrapper, not each carrying their own:
          space-y-6 on the outer container gives every child a fresh mt-6, so
          a second sibling with its own -mt-3 would overlap the first instead
          of sitting a small gap below it. */}
      <div className="-mt-3 space-y-1">
        <p className="text-sm text-muted-foreground">
          Will generate: {scopeSummary}
          {estimateLoading && <span className="ml-1 animate-pulse">— counting…</span>}
          {!estimateLoading && estimate && (
            <span className={
              estimate.overLimit ? 'ml-1 font-medium text-destructive'
                : estimate.softWarn ? 'ml-1 font-medium text-amber-600'
                : 'ml-1 font-medium text-foreground'
            }>
              — {estimate.count.toLocaleString()} job{estimate.count === 1 ? '' : 's'}
              {' '}({estimate.variants.toLocaleString()} variant{estimate.variants === 1 ? '' : 's'})
              {estimate.softWarn && !estimate.overLimit ? ' (large batch)' : ''}
            </span>
          )}
          <span className="ml-2 inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            In-stock only
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Sold-out variants are skipped during generation and excluded from your feed. A job
          is one image; the variant count is what to compare against Feed Coverage on the dashboard.
        </p>
        {estimate?.overLimit && (
          <p className="text-xs text-destructive">
            This would enqueue {estimate.count.toLocaleString()} jobs, over the {estimate.limit.toLocaleString()} limit.
            Narrow the scope — a specific option value, &quot;First pose only&quot;, or a product filter — to continue.
          </p>
        )}
      </div>

      {/* ── Controls + progress ─────────────────────────────────────────────
          Only rendered when there's something to show — the store switcher
          (multi-store only), an in-progress batch, or its result — so a
          single-store merchant who hasn't generated yet doesn't see an empty
          card between "Generate for" and the placement tabs below. */}
      {(stores.length > 1 || generating || genResult) && (
      <Card>
        <CardContent className="p-4 space-y-4">
          {stores.length > 1 && (
            <Select value={selectedStore} onValueChange={setSelectedStore}>
              <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                {stores.map(s => (
                  <SelectItem key={s.id} value={s.id}>{s.shop_name || s.shop_domain}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* ── Progress bar — visible immediately when Generate is clicked ── */}
          {generating && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Progress
                  value={batchProgress && batchProgress.total > 0 ? progressPercent : 0}
                  className="h-3 flex-1"
                />
                <span className="text-sm font-mono tabular-nums shrink-0 text-muted-foreground">
                  {batchProgress
                    ? `${batchProgress.completed + batchProgress.failed + batchProgress.skipped}/${batchProgress.total}`
                    : '0/…'}
                </span>
              </div>

              {batchProgress && batchProgress.total > 0 ? (
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                    <b className="text-green-600">{batchProgress.completed}</b> done
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <b className="text-blue-600">{batchProgress.processing}</b> processing
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                    <b className="text-amber-600">{batchProgress.pending}</b> pending
                  </span>
                  {batchProgress.failed > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                      <b className="text-destructive">{batchProgress.failed}</b> failed
                    </span>
                  )}
                  {batchProgress.skipped > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground" />
                      <b>{batchProgress.skipped}</b> skipped (no matching rule)
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground animate-pulse">
                  Queuing jobs, worker starting…
                </p>
              )}
            </div>
          )}

          {genResult && (
            <p className="text-sm text-muted-foreground">{genResult}</p>
          )}
        </CardContent>
      </Card>
      )}

      {/* Asset-type view tabs — filters which placement's creatives the grid
          below shows; independent of "Generate for" above (that's what gets
          created next, this is what's already been generated). */}
      <div className="flex items-center gap-1 border-b">
        {ALL_ASSET_TYPES.map(type => (
          <button
            key={type}
            type="button"
            onClick={() => setSelectedAssetType(type)}
            className={cn(
              'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              selectedAssetType === type
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {ASSET_TYPE_CONFIG[type].label}
          </button>
        ))}
      </div>

      {/* Creatives grid header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{totalCreatives} creatives</p>
        <div className="flex items-center gap-2">
          {selectedStore && totalCreatives > 0 && (
            <DownloadZipButton storeId={selectedStore} assetType={selectedAssetType} />
          )}
          <Button variant="ghost" size="sm" onClick={fetchCreatives}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" />Refresh
          </Button>
        </div>
      </div>

      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {!loading && creatives.length === 0 && (
        <EmptyState
          icon={ImageIcon}
          title="Generate your first creatives"
          description="Map products to a template in the Rules Engine, then generate — every matching variant gets its own creative."
          action={
            <Button size="lg" asChild>
              <a href="/dashboard/rules">Open Rules Engine</a>
            </Button>
          }
        />
      )}

      {!loading && creatives.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {creatives.map(creative => {
            const product = creative.products
            const template = creative.templates
            const vLabel = variantLabel(creative.product_variants)
            return (
              <Card key={creative.id} className="overflow-hidden group">
                <div className="aspect-square relative bg-muted overflow-hidden">
                  <img src={creative.url} alt={product?.title} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                    <a href={creative.url} download target="_blank" rel="noopener noreferrer">
                      <Button size="icon" variant="secondary" className="h-8 w-8">
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                    <Button size="icon" variant="destructive" className="h-8 w-8"
                      onClick={() => handleDelete(creative.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <CardContent className="p-2.5">
                  <p className="text-xs font-medium truncate">{product?.title}</p>
                  {vLabel && (
                    <p className="text-[11px] text-muted-foreground truncate">{vLabel}</p>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <Badge variant="outline" className="text-xs py-0 shrink-0">
                        {ASSET_TYPE_CONFIG[creative.asset_type ?? 'catalog'].label}
                      </Badge>
                      <Badge variant="outline" className="text-xs py-0 truncate">{template?.name}</Badge>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(creative.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {totalCreatives > PER_PAGE && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button variant="outline" size="sm" disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {Math.ceil(totalCreatives / PER_PAGE)}
          </span>
          <Button variant="outline" size="sm"
            disabled={(page + 1) * PER_PAGE >= totalCreatives}
            onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}

function buildScopeSummary({
  variantScope, variantOptionName, variantOptionValue, imageScope,
}: {
  variantScope: 'all' | 'specific'
  variantOptionName: string
  variantOptionValue: string
  imageScope: 'all' | 'first'
}): string {
  const vPart = variantScope === 'all'
    ? 'all variants'
    : `${variantOptionName || 'option'} ${variantOptionValue || '…'} variants`

  const iPart = imageScope === 'all' ? 'all poses' : 'first pose only'

  return `${vPart} · ${iPart} · all products`
}
