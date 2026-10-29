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
 * aren't a dead end on day one. Scoped per store_id and a no-op (besides
 * returning the existing one) if the store already has any template — safe
 * to call on every OAuth callback, including re-auth/reinstall of an
 * already-connected store.
 *
 * Returns the template id to seed a catch-all rule against — either the
 * newly created one, or the store's existing first template if it already
 * had one but (for whatever reason) no rule yet. Returns null only if the
 * lookup/insert itself failed, in which case there's nothing to point a rule
 * at either.
 */
export async function seedDefaultTemplateIfNeeded(
  supabase: SupabaseClient,
  { userId, storeId }: { userId: string; storeId: string }
): Promise<string | null> {
  try {
    const { data: existing, error: existingError } = await supabase
      .from('templates')
      .select('id')
      .eq('store_id', storeId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (existingError) {
      console.error('[seedDefaultTemplateIfNeeded] lookup failed:', existingError)
      return null
    }
    if (existing) return existing.id

    const { data: inserted, error: insertError } = await supabase
      .from('templates')
      .insert({
        user_id: userId,
        store_id: storeId,
        name: 'Default template',
        description: 'A ready-to-use starting point — product photo, full bleed, white background.',
        category_id: null,
        canvas_data: DEFAULT_CANVAS_DATA,
        asset_type: 'catalog',
        is_active: true,
      })
      .select('id')
      .single()

    if (insertError || !inserted) {
      console.error('[seedDefaultTemplateIfNeeded] insert failed:', insertError)
      return null
    }
    return inserted.id
  } catch (err) {
    console.error('[seedDefaultTemplateIfNeeded] unexpected error:', err)
    return null
  }
}

/**
 * Give a freshly connected store a catch-all "All products" rule pointing at
 * `templateId`, so Creatives doesn't show every job as "skipped (no matching
 * rule)" before the merchant has configured anything. A no-op if the store
 * already has any rule — this is a starting point, not something that should
 * clobber a merchant's own rule set on re-auth.
 *
 * Priority 9999 is deliberately last: any rule a merchant adds afterwards
 * (the "Add rule" form defaults new rules to priority 0) wins over this
 * fallback without them needing to know it exists.
 */
export async function seedCatchAllRuleIfNeeded(
  supabase: SupabaseClient,
  { userId, storeId, templateId }: { userId: string; storeId: string; templateId: string }
): Promise<void> {
  try {
    const { count, error: countError } = await supabase
      .from('template_rules')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)

    if (countError) {
      console.error('[seedCatchAllRuleIfNeeded] count check failed:', countError)
      return
    }
    if (count && count > 0) return

    const { error: insertError } = await supabase.from('template_rules').insert({
      user_id: userId,
      store_id: storeId,
      template_id: templateId,
      name: 'All products (default)',
      conditions: [{ field: 'all_products', operator: 'is', value: '' }],
      condition_mode: 'all',
      rule_type: 'conditions',
      rule_operator: 'all',
      rule_value: '',
      priority: 9999,
      is_active: true,
    })

    if (insertError) {
      console.error('[seedCatchAllRuleIfNeeded] insert failed:', insertError)
    }
  } catch (err) {
    console.error('[seedCatchAllRuleIfNeeded] unexpected error:', err)
  }
}

/**
 * Orchestrates both seeds for a store that just connected (or re-authed).
 * Call this once, right after the store row is saved.
 */
export async function seedStoreDefaults(
  supabase: SupabaseClient,
  { userId, storeId }: { userId: string; storeId: string }
): Promise<void> {
  const templateId = await seedDefaultTemplateIfNeeded(supabase, { userId, storeId })
  if (!templateId) return
  await seedCatchAllRuleIfNeeded(supabase, { userId, storeId, templateId })
}
