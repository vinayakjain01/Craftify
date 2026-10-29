/**
 * GET /api/templates
 * POST /api/templates
 *
 * List the current user's templates, or create a new one under their active store.
 *
 * Auth:     Supabase session via getUser() (src/lib/supabase/get-user.ts)
 * Body:     POST — { name, description?, category_id?, canvas_data, asset_type? }
 *           (name and canvas_data are required; asset_type defaults to
 *           'catalog', an invalid value silently falls back to it)
 * Returns:  GET -> { templates }; POST -> { template }; errors -> { error }
 *
 * Flow: GET: verify user -> select templates for user_id, newest first
 *       POST: parse body + auth + resolve active store in parallel -> validate required fields -> insert scoped to user_id/active store -> return created row
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { ALL_ASSET_TYPES, AssetType, CanvasData } from '@/types/template'

export async function GET() {
  const [user, supabase] = await Promise.all([
    getUser(),
    createClient(),
  ])
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('templates')
    .select('*, template_categories(id, name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ templates: data })
}

export async function POST(request: NextRequest) {
  // Parse body + authenticate + resolve active store — all in parallel
  const [body, user, { activeStoreId }] = await Promise.all([
    request.json(),
    getUser(),
    getActiveStore(),
  ])

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!activeStoreId) {
    return NextResponse.json({ error: 'No active store. Connect a store first.' }, { status: 400 })
  }

  const { name, description, category_id, canvas_data, asset_type } = body
  if (!name || !canvas_data) {
    return NextResponse.json({ error: 'name and canvas_data required' }, { status: 400 })
  }
  const resolvedAssetType: AssetType = ALL_ASSET_TYPES.includes(asset_type) ? asset_type : 'catalog'

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('templates')
    .insert({
      user_id: user.id,
      store_id: activeStoreId,
      name,
      description: description || null,
      category_id: category_id || null,
      canvas_data,
      asset_type: resolvedAssetType,
      is_active: true,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data })
}