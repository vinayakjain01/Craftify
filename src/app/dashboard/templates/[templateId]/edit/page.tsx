import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { TemplateBuilderClient } from '@/components/builder/template-builder-client'

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>
}) {
  const [{ templateId }, supabase, user] = await Promise.all([
    params,
    createClient(),
    getUser(), // React-cached — no extra Supabase auth round-trip
  ])

  const [{ data: template }, { data: categories }, { activeStoreId }] = await Promise.all([
    supabase
      .from('templates')
      .select('*')
      .eq('id', templateId)
      .eq('user_id', user!.id)
      .single(),
    supabase
      .from('template_categories')
      .select('*')
      .eq('user_id', user!.id)
      .order('name'),
    getActiveStore(),
  ])

  if (!template) notFound()

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
      template={template}
      categories={categories ?? []}
      previewProducts={previewProducts}
      storeId={activeStoreId}
    />
  )
}