import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import { RulesClient } from '@/components/rules/rules-client'

export default async function RulesPage() {
  const supabase = await createClient()
  const { activeStoreId, stores } = await getActiveStore()

  // Templates for the active store only (rules are store-scoped). Not
  // filtered by is_active — there's no "archive a template" feature
  // anywhere in the app (deleting one is a hard delete), so every template
  // a merchant can see on the Templates page must also be selectable here.
  const { data: templates } = activeStoreId
    ? await supabase.from('templates').select('id, name')
        .eq('store_id', activeStoreId)
    : { data: [] }

  const activeStores = stores
    .filter(s => s.id === activeStoreId)
    .map(s => ({ id: s.id, shop_name: s.shop_name || '', shop_domain: s.shop_domain }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Rules Engine</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Automatically assign templates to products based on tags, vendor, type, or discount
        </p>
      </div>
      <RulesClient stores={activeStores} templates={templates || []} />
    </div>
  )
}