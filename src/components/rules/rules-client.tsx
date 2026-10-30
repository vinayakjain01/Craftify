'use client'

/**
 * Rules Engine — map product criteria to a template.
 *
 * v2 — MULTI-CONDITION. A rule was previously a single field/operator/value
 * triple, so "vendor is Saundh AND type is Kaftan" was unexpressible. A rule now
 * holds a list of conditions combined with ALL (AND) or ANY (OR).
 *
 * Priority is ascending: 0 is evaluated first and the first matching rule wins.
 * That is the opposite of the pre-v2 behaviour, so the list is ordered — and
 * labelled — to make the evaluation order unambiguous.
 */
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { shopifyFetch } from '@/lib/shopify-token'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Trash2, Plus, Zap, ArrowRight, X } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import type { RuleCondition, RuleField, RuleOperator } from '@/lib/template-resolver'

const FIELDS: { value: RuleField; label: string; kind: 'text' | 'number' | 'none' }[] = [
  { value: 'tag',            label: 'Tag',              kind: 'text' },
  { value: 'vendor',         label: 'Vendor',           kind: 'text' },
  { value: 'product_type',   label: 'Product type',     kind: 'text' },
  { value: 'collection',     label: 'Collection',       kind: 'text' },
  { value: 'title_contains', label: 'Title contains',   kind: 'text' },
  { value: 'sku_prefix',     label: 'SKU starts with',  kind: 'text' },
  { value: 'price_min',      label: 'Price at least',   kind: 'number' },
  { value: 'price_max',      label: 'Price at most',    kind: 'number' },
  { value: 'all_products',   label: 'All products',     kind: 'none' },
]

const TEXT_OPERATORS: { value: RuleOperator; label: string }[] = [
  { value: 'is',          label: 'is' },
  { value: 'is_not',      label: 'is not' },
  { value: 'contains',    label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
]

function fieldKind(field: RuleField) {
  return FIELDS.find(f => f.value === field)?.kind ?? 'text'
}

function fieldLabel(field: string) {
  return FIELDS.find(f => f.value === field)?.label ?? field
}

interface Rule {
  id: string
  name: string | null
  priority: number
  is_active: boolean
  conditions: RuleCondition[] | null
  condition_mode: 'all' | 'any' | null
  rule_type: string | null
  rule_operator: string | null
  rule_value: string | null
  templates: { id: string; name: string } | null
}

interface Props {
  stores: { id: string; shop_name: string; shop_domain: string }[]
  templates: { id: string; name: string }[]
  /** Whether this store has generated any creative yet — drives the
   * "next step" nudge toward Creatives once a rule exists but nothing's
   * been generated. */
  hasGeneratedCreatives: boolean
  /** Pre-select this template in the New rule form — set when the merchant
   * arrives here via a template's "Set up a rule" link
   * (/dashboard/rules?templateId=...) rather than navigating in directly. */
  initialTemplateId?: string
}

// "All products" first: it's the simplest, most common rule (one template for
// the whole catalog), and the one the guided "create template -> set up a
// rule" flow expects to see already selected rather than making the merchant
// switch off "Tag" first.
const emptyCondition = (): RuleCondition => ({ field: 'all_products', operator: 'is', value: '' })

export function RulesClient({ stores, templates, hasGeneratedCreatives, initialTemplateId }: Props) {
  const [selectedStore, setSelectedStore] = useState(stores[0]?.id || '')
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)

  // New rule form
  const [name, setName] = useState('')
  const [conditions, setConditions] = useState<RuleCondition[]>([emptyCondition()])
  const [mode, setMode] = useState<'all' | 'any'>('all')
  const [templateId, setTemplateId] = useState(initialTemplateId || '')
  const [priority, setPriority] = useState(0)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Reload after a mutation. Safe to call from an event handler, where setting
   * state synchronously is fine.
   */
  const fetchRules = useCallback(async () => {
    if (!selectedStore) return
    setLoading(true)
    const res = await shopifyFetch(`/api/rules?storeId=${selectedStore}`)
    const data = await res.json()
    setRules(data.rules || [])
    setLoading(false)
  }, [selectedStore])

  /**
   * Load on mount and whenever the store changes.
   *
   * State is only set AFTER the request resolves — setting `loading` before the
   * first await would be a synchronous set-state inside an effect, which
   * cascades renders (and the React Compiler rejects it). `loading` therefore
   * starts true instead.
   *
   * The `cancelled` flag drops a response whose request was superseded, so
   * switching stores quickly cannot let a slow earlier response overwrite the
   * newer one.
   */
  useEffect(() => {
    if (!selectedStore) return
    let cancelled = false

    shopifyFetch(`/api/rules?storeId=${selectedStore}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        setRules(data.rules || [])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [selectedStore])

  function updateCondition(index: number, patch: Partial<RuleCondition>) {
    setConditions(cur => cur.map((c, i) => {
      if (i !== index) return c
      const next = { ...c, ...patch }
      // Switching to a field that takes no value must clear any stale value,
      // otherwise "All products" would submit a leftover string.
      if (patch.field && fieldKind(patch.field) === 'none') next.value = ''
      return next
    }))
  }

  async function handleAdd() {
    if (!templateId || !selectedStore) return
    setError(null)

    const usable = conditions.filter(c => c.value.trim() !== '' || c.field === 'all_products')
    if (usable.length === 0) {
      setError('Add at least one condition with a value')
      return
    }

    setAdding(true)
    const res = await shopifyFetch('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        store_id: selectedStore,
        template_id: templateId,
        name: name.trim() || null,
        conditions: usable,
        condition_mode: mode,
        priority,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      // Re-fetch rather than prepend: the server orders by priority, and a new
      // rule rarely belongs at the top of that order.
      await fetchRules()
      setName('')
      setConditions([emptyCondition()])
      setTemplateId('')
    } else {
      setError(data.error || 'Could not create rule')
    }
    setAdding(false)
  }

  async function handleDelete(ruleId: string) {
    await shopifyFetch(`/api/rules/${ruleId}`, { method: 'DELETE' })
    setRules(prev => prev.filter(r => r.id !== ruleId))
  }

  if (stores.length === 0) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        <p>No stores connected. Go to Settings first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {stores.length > 1 && (
        <Select value={selectedStore} onValueChange={setSelectedStore}>
          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>
            {stores.map(s => (
              <SelectItem key={s.id} value={s.id}>{s.shop_name || s.shop_domain}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* ── New rule ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New rule</CardTitle>
          <CardDescription>
            Products matching these conditions get the chosen template. Rules are
            checked in priority order and the first match wins.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Rule name (optional)
              </label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Festive kaftans" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Match
              </label>
              <Select value={mode} onValueChange={v => setMode(v as 'all' | 'any')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">ALL conditions (AND)</SelectItem>
                  <SelectItem value="any">ANY condition (OR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Conditions */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground">Conditions</label>
            {conditions.map((c, i) => {
              const kind = fieldKind(c.field)
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select value={c.field} onValueChange={v => updateCondition(i, { field: v as RuleField })}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FIELDS.map(f => (
                        <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {kind === 'text' && (
                    <Select value={c.operator} onValueChange={v => updateCondition(i, { operator: v as RuleOperator })}>
                      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TEXT_OPERATORS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {kind !== 'none' && (
                    <Input
                      className="w-52"
                      type={kind === 'number' ? 'number' : 'text'}
                      value={c.value}
                      onChange={e => updateCondition(i, { value: e.target.value })}
                      placeholder={kind === 'number' ? '2000' : 'value'}
                    />
                  )}

                  {conditions.length > 1 && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => setConditions(cur => cur.filter((_, j) => j !== i))}
                      aria-label="Remove condition"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )
            })}
            <Button size="sm" variant="outline" onClick={() => setConditions(cur => [...cur, emptyCondition()])}>
              <Plus className="h-3.5 w-3.5" />
              Add condition
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Template</label>
              <Select value={templateId} onValueChange={setTemplateId} disabled={templates.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={templates.length === 0 ? 'No templates yet' : 'Choose a template'} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {templates.length === 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  No templates yet —{' '}
                  <Link href="/dashboard/templates/new" className="underline underline-offset-2">
                    create one first
                  </Link>
                  .
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Priority (0 = first)
              </label>
              <Input
                type="number"
                value={priority}
                onChange={e => setPriority(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {!error && !templateId && templates.length > 0 && (
            <p className="text-sm text-muted-foreground">Choose a template to enable &quot;Add rule&quot;.</p>
          )}

          <Button onClick={handleAdd} disabled={adding || !templateId}>
            <Plus className="h-4 w-4" />
            {adding ? 'Adding…' : 'Add rule'}
          </Button>
        </CardContent>
      </Card>

      {/* Next-step nudge: a rule with nothing generated yet means the
          merchant has set everything up but hasn't actually produced a
          creative — "Creatives" isn't an obvious next click from here. */}
      {!loading && rules.length > 0 && !hasGeneratedCreatives && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm">
              <Zap className="h-4 w-4 text-primary" />
              <span>Rules are set up — next, generate your first creatives.</span>
            </div>
            <Link href="/dashboard/creatives">
              <Button size="sm">
                Generate creatives
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ── Existing rules ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Rules in evaluation order
        </h2>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!loading && rules.length === 0 && (
          <EmptyState
            icon={Zap}
            title="Add your first rule"
            description="Rules decide which template each product gets. Until one matches, nothing will generate."
          />
        )}

        {rules.map((rule, index) => (
          <Card key={rule.id}>
            <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <Badge variant="secondary" className="tabular-nums">#{index + 1}</Badge>

              <div className="min-w-0 flex-1">
                {rule.name && <p className="font-medium">{rule.name}</p>}
                <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                  {(rule.conditions?.length ?? 0) > 0 ? (
                    rule.conditions!.map((c, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        {i > 0 && (
                          <span className="text-[10px] font-semibold uppercase opacity-70">
                            {rule.condition_mode === 'any' ? 'or' : 'and'}
                          </span>
                        )}
                        <Badge variant="outline" className="py-0 text-xs">
                          {fieldLabel(c.field)}
                          {c.field !== 'all_products' && ` ${c.operator.replace('_', ' ')} ${c.value}`}
                        </Badge>
                      </span>
                    ))
                  ) : (
                    <Badge variant="outline" className="py-0 text-xs">
                      {rule.rule_type
                        ? `${fieldLabel(rule.rule_type)} ${rule.rule_operator ?? ''} ${rule.rule_value ?? ''}`
                        : 'No conditions — never matches'}
                    </Badge>
                  )}
                </div>
              </div>

              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium">{rule.templates?.name ?? 'Template removed'}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                priority {rule.priority}
              </span>

              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => handleDelete(rule.id)}
                aria-label="Delete rule"
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
