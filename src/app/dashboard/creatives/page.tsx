import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { CreativesClient } from '@/components/creatives/creatives-client'

// Must match CreativesClient's own PER_PAGE and default selectedAssetType —
// this is seeding the exact first page the client would otherwise fetch
// itself on mount.
const PER_PAGE = 12
const DEFAULT_ASSET_TYPE = 'catalog'

export default async function CreativesPage() {
  const supabase = await createClient()
  const { activeStoreId, stores } = await getActiveStore()

  // Pass ONLY the active store so the client never shows another store's data.
  const activeStores = stores
    .filter(s => s.id === activeStoreId)
    .map(s => ({ id: s.id, shop_name: s.shop_name || '', shop_domain: s.shop_domain }))

  // Same query CreativesClient's own mount-time fetch runs, just done here so
  // the grid has real data on first paint instead of waiting on a client
  // round-trip after the page has already rendered.
  const { data: initialCreatives, count: initialTotalCreatives } = activeStoreId
    ? await supabase
        .from('generated_creatives')
        .select(`
          id, url, created_at, template_id, cloudinary_id, variant_id, asset_type,
          products(title),
          product_variants(title, option1, option2, option3),
          templates(name)
        `, { count: 'exact' })
        .eq('store_id', activeStoreId)
        .eq('asset_type', DEFAULT_ASSET_TYPE)
        .order('created_at', { ascending: false })
        .range(0, PER_PAGE - 1)
    : { data: [], count: 0 }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Creatives</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate and manage your catalog creatives
        </p>
      </div>
      <CreativesClient
        stores={activeStores}
        // Supabase infers joined relations as arrays without an explicit FK
        // hint; CreativesClient's own client-side fetch of this exact query
        // shape casts the same way (setCreatives((data as any) || [])).
        initialCreatives={(initialCreatives as any) || []}
        initialTotalCreatives={initialTotalCreatives || 0}
      />
    </div>
  )
}