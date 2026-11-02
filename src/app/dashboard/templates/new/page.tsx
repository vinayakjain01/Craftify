import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { TemplateBuilderClient } from '@/components/builder/template-builder-client'

export default async function NewTemplatePage() {
  const [supabase, user] = await Promise.all([createClient(), getUser()])

  const [{ data: categories }, { activeStoreId }] = await Promise.all([
    supabase
      .from('template_categories')
      .select('*')
      .eq('user_id', user!.id)
      .order('name'),
    getActiveStore(), // React-cached getUser() internally — no extra round-trip
  ])

  let previewProducts: any[] = []

  if (activeStoreId) {
    const { data } = await supabase
      .from('products')
      .select(`
        id, title, price, compare_at_price, vendor, product_type,
        product_images(src, is_primary)
      `)
      .eq('store_id', activeStoreId)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(100)

    previewProducts = data ?? []
  }

  return (
    <TemplateBuilderClient
      categories={categories ?? []}
      previewProducts={previewProducts}
      storeId={activeStoreId}
    />
  )
}