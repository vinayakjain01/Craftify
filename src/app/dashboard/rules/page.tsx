import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { RulesClient } from '@/components/rules/rules-client'

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<{ templateId?: string }>
}) {
  const [{ templateId }, supabase, user, { activeStoreId, stores }] = await Promise.all([
    searchParams,
    createClient(),
    getUser(), // React-cached — no extra Supabase auth round-trip
    getActiveStore(),
  ])

  // Templates for the active store only (rules are store-scoped). Not
  // filtered by is_active — there's no "archive a template" feature
  // anywhere in the app (deleting one is a hard delete), so every template
  // a merchant can see on the Templates page must also be selectable here.
  //
  // The rules list itself is fetched here too (same query as GET /api/rules)
  // so RulesClient can render with real data on first paint instead of
  // showing "Loading..." for a whole extra client round-trip after the page
  // has already rendered — that second round-trip (plus its own separate
  // auth check) was the main cause of Rules Engine feeling slow to finish
  // rendering even though the page itself loaded fine.
  const [{ data: templates }, { count: creativeCount }, { data: initialRules }] = activeStoreId
    ? await Promise.all([
        supabase.from('templates').select('id, name').eq('store_id', activeStoreId),
        supabase
          .from('generated_creatives')
          .select('id', { count: 'exact', head: true })
          .eq('store_id', activeStoreId),
        supabase
          .from('template_rules')
          .select('*, templates(id, name)')
          .eq('user_id', user!.id)
          .eq('store_id', activeStoreId)
          .order('priority', { ascending: true })
          .order('created_at', { ascending: true }),
      ])
    : [{ data: [] }, { count: 0 }, { data: [] }]

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
      <RulesClient
        stores={activeStores}
        templates={templates || []}
        hasGeneratedCreatives={(creativeCount ?? 0) > 0}
        initialTemplateId={templateId}
        initialRules={initialRules || []}
      />
    </div>
  )
}