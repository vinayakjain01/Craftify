import { createClient } from '@/lib/supabase/server'
import { getActiveStore } from '@/lib/active-store'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, Pencil, Layers } from 'lucide-react'
import { DeleteTemplateButton } from '@/components/templates/delete-template-button'
import { EmptyState } from '@/components/ui/empty-state'
import { ASSET_TYPE_CONFIG, AssetType } from '@/types/template'
import { ArrowRight, Zap } from 'lucide-react'

export default async function TemplatesPage() {
  const supabase = await createClient()
  const { activeStoreId } = await getActiveStore()

  const [{ data: templates }, { count: rulesCount }] = activeStoreId
    ? await Promise.all([
        supabase
          .from('templates')
          .select('*, template_categories(name)')
          .eq('store_id', activeStoreId)
          .order('created_at', { ascending: false }),
        supabase
          .from('template_rules')
          .select('id', { count: 'exact', head: true })
          .eq('store_id', activeStoreId),
      ])
    : [{ data: [] }, { count: 0 }]

  // Next-step nudge: a template with no rule yet can never actually generate
  // anything, and "Rules Engine" isn't an obvious next click from here.
  const showRuleNudge = (templates?.length ?? 0) > 0 && !rulesCount

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {templates?.length || 0} templates
          </p>
        </div>
        <Link href="/dashboard/templates/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New template
          </Button>
        </Link>
      </div>

      {showRuleNudge && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm">
              <Zap className="h-4 w-4 text-primary" />
              <span>
                You have a template — next, set up a rule so products actually get assigned to it.
              </span>
            </div>
            <Link href="/dashboard/rules">
              <Button size="sm">
                Set up a rule
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {templates && templates.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {templates.map(template => (
            <Card key={template.id} className="overflow-hidden group">
              {/* Canvas preview thumbnail */}
              <div className="aspect-square bg-muted flex items-center justify-center relative overflow-hidden">
                {template.thumbnail_url ? (
                  <img
                    src={template.thumbnail_url}
                    alt={template.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center"
                    style={{
                      backgroundColor:
                        (template.canvas_data as any)?.backgroundColor || '#f3f4f6',
                    }}
                  >
                    <Layers className="h-10 w-10 text-muted-foreground/30" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                  <Link href={`/dashboard/templates/${template.id}/edit`}>
                    <Button size="sm" variant="secondary">
                      <Pencil className="h-3.5 w-3.5 mr-1.5" />
                      Edit
                    </Button>
                  </Link>
                </div>
              </div>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{template.name}</p>
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      <Badge variant="secondary" className="text-xs">
                        {ASSET_TYPE_CONFIG[((template as any).asset_type ?? 'catalog') as AssetType].label}
                      </Badge>
                      {(template as any).template_categories?.name && (
                        <Badge variant="outline" className="text-xs">
                          {(template as any).template_categories.name}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <DeleteTemplateButton templateId={template.id} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Layers}
          title="Design your first template"
          description="A template is the layered canvas your product photos are composited into — add text, badges and a logo once, then apply it across the catalog."
          action={
            <Button size="lg" asChild>
              <Link href="/dashboard/templates/new">
                <Plus className="h-4 w-4" />
                Create template
              </Link>
            </Button>
          }
        />
      )}
    </div>
  )
}