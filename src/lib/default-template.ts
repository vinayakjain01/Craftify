import type { SupabaseClient } from '@supabase/supabase-js'
import type { CanvasData } from '@/types/template'

/**
 * The same blank canvas a merchant gets when they open the builder and hit
 * "New template" with nothing loaded yet — see template-builder-client.tsx's
 * loadTemplate() fallback. Kept in sync manually since the two call sites
 * (one client-side default, one server-seeded row) serve different purposes:
 * this one needs to exist before the merchant ever opens the builder.
 */
const DEFAULT_CANVAS_DATA: CanvasData = {
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
    },
  ],
}

/**
 * Give a freshly connected store one ready-to-use template, so Rules Engine
 * (which needs at least one template to create a rule against) and Creatives
 * aren't a dead end on day one. Scoped per store_id and a no-op if the store
 * already has any template — safe to call on every OAuth callback, including
 * re-auth/reinstall of an already-connected store.
 */
export async function seedDefaultTemplateIfNeeded(
  supabase: SupabaseClient,
  { userId, storeId }: { userId: string; storeId: string }
): Promise<void> {
  try {
    const { count, error: countError } = await supabase
      .from('templates')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)

    if (countError) {
      console.error('[seedDefaultTemplateIfNeeded] count check failed:', countError)
      return
    }
    if (count && count > 0) return

    const { error: insertError } = await supabase.from('templates').insert({
      user_id: userId,
      store_id: storeId,
      name: 'Default template',
      description: 'A ready-to-use starting point — product photo, full bleed, white background.',
      category_id: null,
      canvas_data: DEFAULT_CANVAS_DATA,
      asset_type: 'catalog',
      is_active: true,
    })

    if (insertError) {
      console.error('[seedDefaultTemplateIfNeeded] insert failed:', insertError)
    }
  } catch (err) {
    console.error('[seedDefaultTemplateIfNeeded] unexpected error:', err)
  }
}
