'use client'

import { shopifyFetch } from '@/lib/shopify-token'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useBuilderStore } from '@/stores/builder-store'
import { CanvasPreview } from './canvas-preview'
import { LayerPanel } from './layer-panel'
import { LayerProperties } from './layer-properties'
import { ToolBar } from './toolbar'
import { ProductPreviewSelector } from './product-preview-selector'
import { AiProductModePanel } from './ai-product-mode-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Save, ArrowLeft, Loader2, Layers, Sparkles, Zap, ArrowRight } from 'lucide-react'
import {
  CanvasData, AspectRatio, ASPECT_RATIOS, PRODUCT_LAYER_ID,
  AssetType, ALL_ASSET_TYPES, ASSET_TYPE_CONFIG,
} from '@/types/template'
import Link from 'next/link'

interface Props {
  template?: {
    id: string
    name: string
    description: string | null
    category_id: string | null
    canvas_data: CanvasData
    asset_type?: AssetType | null
  }
  categories: { id: string; name: string }[]
  previewProducts?: any[]
  storeId?: string | null
}

type RightPanelTab = 'layers' | 'properties' | 'ai'

export function TemplateBuilderClient({ template, categories, previewProducts = [], storeId }: Props) {
  const router = useRouter()
  const { canvasData, loadTemplate, isDirty, resetDirty, setAspectRatio, selectedLayerId } = useBuilderStore()
  const [name, setName] = useState(template?.name || 'Untitled template')
  const [categoryId, setCategoryId] = useState(template?.category_id || 'none')
  const [assetType, setAssetType] = useState<AssetType>(template?.asset_type ?? 'catalog')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rightTab, setRightTab] = useState<RightPanelTab>('layers')

  /**
   * Picking a placement sets the canvas to its exact dimensions via the same
   * setAspectRatio() the raw aspect-ratio picker uses (every ASSET_TYPE_CONFIG
   * aspect ratio is already one of the ASPECT_RATIOS presets) — a good
   * default, not a lock: the aspect-ratio picker below can still be changed
   * afterwards. If it is, the LIVE PREVIEW here reflects that custom size, but
   * generation always renders at the placement's own fixed dimensions (see
   * runJob in generation-queue.ts) — the stored canvas_data size is a preview
   * convenience, not what asset_type-aware generation actually outputs.
   */
  function handleAssetTypeChange(value: AssetType) {
    setAssetType(value)
    setAspectRatio(ASSET_TYPE_CONFIG[value].aspectRatio)
  }

  // Auto-switch panels on selection: the implicit product layer's controls
  // live in the AI panel; regular layers use the properties panel.
  useEffect(() => {
    if (selectedLayerId === PRODUCT_LAYER_ID) setRightTab('ai')
    else if (selectedLayerId) setRightTab('properties')
  }, [selectedLayerId])

  useEffect(() => {
    if (template?.canvas_data) {
      loadTemplate(template.canvas_data)
    } else {
      loadTemplate({
        width: 1080,
        height: 1080,
        aspectRatio: '1:1',
        backgroundColor: '#ffffff',
        backgroundImageUrl: null,
        layers: [
          {
            id: 'base-product-image',
            type: 'image',
            x: 0, y: 0, width: 100, height: 100,
            rotation: 0, opacity: 1, zIndex: 0,
            src: '{{product_image}}',
            objectFit: 'contain',
            borderRadius: 0,
          } as any,
        ],
      })
    }
  }, [template])

  async function handleSave() {
    setSaving(true)
    setError('')

    const payload = {
      name,
      category_id: categoryId === 'none' ? null : categoryId,
      canvas_data: canvasData,
      asset_type: assetType,
    }

    const url = template ? `/api/templates/${template.id}` : '/api/templates'
    const method = template ? 'PUT' : 'POST'

    const res = await shopifyFetch(url, {
      method,
      body: JSON.stringify(payload),
    })

    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Save failed')
    } else {
      resetDirty()
      const templateId = template?.id || data.template.id
      shopifyFetch(`/api/templates/${templateId}/thumbnail`, { method: 'POST' }).catch(() => {})
      if (!template) {
        router.push(`/dashboard/templates/${templateId}/edit`)
      } else {
        router.refresh()
      }
    }
    setSaving(false)
  }

  const isAiMode = canvasData.templateMode === 'ai_product'

  return (
    <div className="flex flex-col h-screen -m-6">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-card flex-shrink-0 gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Link href="/dashboard/templates">
            <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            className="h-8 w-44 font-medium text-sm"
          />

          <Select
            value={assetType}
            onValueChange={v => handleAssetTypeChange(v as AssetType)}
          >
            <SelectTrigger className="h-8 w-44 *:data-[slot=select-value]:min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Label + description in ONE row, not stacked — Radix mirrors an
                  item's full children into the closed trigger, so a stacked
                  pair here would centre two lines in the trigger instead of
                  reading as a single compact control (see the identical fix
                  applied to the Creatives page's scope selectors). */}
              {ALL_ASSET_TYPES.map(t => (
                <SelectItem key={t} value={t}>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="font-medium shrink-0">{ASSET_TYPE_CONFIG[t].label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {ASSET_TYPE_CONFIG[t].aspectRatio}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={canvasData.aspectRatio || '1:1'}
            onValueChange={v => setAspectRatio(v as AspectRatio)}
          >
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECT_RATIOS.map(r => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No category</SelectItem>
              {categories.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* AI Mode indicator */}
          {isAiMode && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 text-primary">
              <Sparkles className="h-3 w-3" />
              <span className="text-xs font-medium">AI Mode</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {isDirty && <span className="text-xs text-muted-foreground">Unsaved</span>}
          {/* Only once this template has an id (saved at least once) — a
              rule needs a real template_id to point at. This is also what
              the "New template" -> Save redirect lands on, so it's the
              first thing visible right after creating one. */}
          {template && (
            <Link href={`/dashboard/rules?templateId=${template.id}`}>
              <Button size="sm" variant="outline">
                <Zap className="h-3.5 w-3.5 mr-1.5" />
                Set up a rule
                <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </Link>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Saving…</>
              : <><Save className="h-3.5 w-3.5 mr-1.5" />Save</>
            }
          </Button>
        </div>
      </div>

      {/* Builder body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel */}
        <div className="w-56 border-r flex flex-col bg-card overflow-hidden flex-shrink-0">
          <ProductPreviewSelector products={previewProducts} />
          <ToolBar />
          <LayerPanel />
        </div>

        {/* Center canvas */}
        <div className="flex-1 bg-muted/30 flex items-center justify-center overflow-auto p-8">
          <CanvasPreview storeId={storeId} />
        </div>

        {/* Right panel */}
        <div className="w-64 border-l bg-card flex flex-col overflow-hidden flex-shrink-0">
          {/* Tab bar */}
          <div className="flex border-b flex-shrink-0">
            <TabButton
              active={rightTab === 'layers'}
              onClick={() => setRightTab('layers')}
              icon={<Layers className="h-3.5 w-3.5" />}
              label="Layers"
            />
            <TabButton
              active={rightTab === 'properties'}
              onClick={() => setRightTab('properties')}
              label="Props"
            />
            <TabButton
              active={rightTab === 'ai'}
              onClick={() => setRightTab('ai')}
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="AI"
              highlight={isAiMode}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {rightTab === 'layers' && <LayerPanel embedded />}
            {rightTab === 'properties' && <LayerProperties />}
            {rightTab === 'ai' && <AiProductModePanel />}
          </div>
        </div>
      </div>
    </div>
  )
}

function TabButton({
  active, onClick, icon, label, highlight,
}: {
  active: boolean
  onClick: () => void
  icon?: React.ReactNode
  label: string
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium border-b-2 transition-colors ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      } ${highlight && !active ? 'text-primary/70' : ''}`}
    >
      {icon}
      {label}
      {highlight && !active && (
        <span className="w-1.5 h-1.5 rounded-full bg-primary" />
      )}
    </button>
  )
}