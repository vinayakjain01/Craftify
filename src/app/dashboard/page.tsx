import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { findUncoveredInStockVariants } from '@/lib/generation-queue'
import { formatDistanceToNow } from 'date-fns'
import { ALL_ASSET_TYPES, ASSET_TYPE_CONFIG } from '@/types/template'
import {
  ShoppingBag, Layers, ImageIcon, Zap, AlertTriangle,
  Clock, Loader2, X, ArrowUpRight, RefreshCw, Wand2, Plus, Settings,
} from 'lucide-react'

interface RecentCreative {
  id: string
  url: string
  created_at: string
  products: { title: string } | null
  templates: { name: string } | null
}

/**
 * Surfaces why a Shopify token refresh failed.
 *
 * Without this the failure only reached a serverless log: the app loaded
 * normally, the "token expired" banner never cleared, and there was no way to
 * tell a failed exchange apart from one that never ran.
 */
function AuthErrorNotice({ reason }: { reason: string }) {
  const isMissingToken = reason === 'no_id_token'
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
        Shopify token was not refreshed
      </p>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
        {isMissingToken
          ? 'This page was opened outside the Shopify admin, so Shopify did not provide a session token to exchange. Open the app from Shopify admin → Apps → Craftify to refresh it.'
          : reason}
      </p>
    </div>
  )
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>
}) {
  const { auth_error: authError } = await searchParams
  // Both calls share one Supabase auth round-trip (React cache).
  const [user, { activeStoreId, stores: storeList }] = await Promise.all([
    getUser(),
    getActiveStore(),
  ])

  // No store connected yet — a merchant who signed in without ever going
  // through Shopify OAuth (e.g. the review test account) has nothing for the
  // metric queries below to aggregate. Skip them entirely and point at the
  // one thing that actually unblocks them, rather than rendering a full
  // dashboard of all-zero stats.
  if (storeList.length === 0) {
    return (
      <div style={{
        fontFamily: 'var(--font-sans-family)', color: '#241A3D',
        display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh',
      }}>
        <div style={{
          background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14,
          padding: '32px 28px', maxWidth: 440, textAlign: 'center',
        }}>
          <h2 style={{ fontFamily: 'var(--font-heading-family)', fontSize: 20, fontWeight: 600, color: '#241A3D', margin: '0 0 8px' }}>
            Connect your Shopify store
          </h2>
          <p style={{ fontSize: 13.5, color: '#6B6280', margin: '0 0 20px' }}>
            Craftify generates catalog creatives from a connected store&apos;s products.
            Connect one from Settings to get started.
          </p>
          <Link
            href="/dashboard/settings"
            style={{
              display: 'inline-block', background: '#4B2E83', color: '#fff',
              borderRadius: 10, padding: '10px 20px', fontSize: 13.5, fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Connect Shopify store
          </Link>
        </div>
      </div>
    )
  }

  const supabase = await createClient()

  // All metric queries run in parallel — previously 4 sequential calls.
  const countQueries = activeStoreId
    ? Promise.all([
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
        supabase.from('templates').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
        // generated_creatives carries store_id directly, so this no longer needs
        // an inner join through products — and it counts per VARIANT, which is
        // what actually gets generated in v2.
        supabase
          .from('generated_creatives')
          .select('id', { count: 'exact', head: true })
          .eq('store_id', activeStoreId),
      ])
    : Promise.resolve([{ count: 0 }, { count: 0 }, { count: 0 }] as Array<{ count: number | null }>)

  const activeStoreQuery = activeStoreId
    ? supabase.from('stores').select('*').eq('id', activeStoreId).single()
    : Promise.resolve({ data: null })

  // Feed coverage: how much of what will actually show in the Meta feed (only
  // in-stock variants of active products — see the In-Stock Only feed rule)
  // already has a generated creative. The "covered" half can't be a plain
  // count query — PostgREST has no distinct-count-across-a-join filter — so
  // it reuses the same uncovered-variant lookup the sync's restock check
  // uses, and derives covered = total - uncovered.
  const totalInStockQuery = activeStoreId
    ? supabase
        .from('product_variants')
        .select('id, products!inner(status)', { count: 'exact', head: true })
        .eq('store_id', activeStoreId)
        .eq('is_sold_out', false)
        .eq('products.status', 'active')
    : Promise.resolve({ count: 0 })

  const uncoveredQuery = activeStoreId
    ? findUncoveredInStockVariants(activeStoreId, supabase).catch(() => [])
    : Promise.resolve([] as Array<{ id: string; product_id: string }>)

  // Rules count (total + active)
  const rulesQuery = activeStoreId
    ? Promise.all([
        supabase.from('template_rules').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId),
        supabase.from('template_rules').select('*', { count: 'exact', head: true }).eq('store_id', activeStoreId).eq('is_active', true),
      ])
    : Promise.resolve([{ count: 0 }, { count: 0 }] as Array<{ count: number | null }>)

  // Generation queue stats (pending / processing / failed only)
  const queueQuery = activeStoreId
    ? supabase
        .from('generation_jobs')
        .select('status')
        .eq('store_id', activeStoreId)
        .in('status', ['pending', 'processing', 'failed'])
    : Promise.resolve({ data: [] as Array<{ status: string }> })

  // Asset breakdown — creative count per placement (catalog/feed/story/reel).
  // One count query per type rather than a single grouped query, since
  // PostgREST has no group-by without an RPC — matching the count-query style
  // already used above for products/templates/creatives.
  const assetBreakdownQuery = activeStoreId
    ? Promise.all(
        ALL_ASSET_TYPES.map(t =>
          supabase
            .from('generated_creatives')
            .select('id', { count: 'exact', head: true })
            .eq('store_id', activeStoreId)
            .eq('asset_type', t)
        )
      )
    : Promise.resolve(ALL_ASSET_TYPES.map(() => ({ count: 0 })) as Array<{ count: number | null }>)

  // Recent creatives — last 3 with product title
  const recentCreativesQuery = activeStoreId
    ? supabase
        .from('generated_creatives')
        .select('id, url, created_at, products(title), templates(name)')
        .eq('store_id', activeStoreId)
        .order('created_at', { ascending: false })
        .limit(3)
    : Promise.resolve({ data: [] as RecentCreative[] })

  // needs_reauth isn't on StoreLite (getActiveStore() deliberately keeps that
  // type minimal), so it's fetched here rather than widening a shared type
  // for one banner.
  const reauthQuery = user
    ? supabase.from('stores').select('id, needs_reauth').eq('user_id', user.id)
    : Promise.resolve({ data: [] as Array<{ id: string; needs_reauth: boolean | null }> })

  const [
    [pc, tc, cc],
    { data: activeStore },
    totalInStockResult,
    uncoveredInStock,
    [rulesTotal, rulesActive],
    assetBreakdownResult,
    { data: queueJobs },
    { data: recentCreatives },
    { data: reauthStores },
  ] = await Promise.all([
    countQueries,
    activeStoreQuery,
    totalInStockQuery,
    uncoveredQuery,
    rulesQuery,
    assetBreakdownQuery,
    queueQuery,
    recentCreativesQuery,
    reauthQuery,
  ])

  const productCount  = pc.count  || 0
  const templateCount = tc.count  || 0
  const creativeCount = cc.count  || 0

  const totalInStock    = totalInStockResult.count || 0
  const uncoveredCount  = uncoveredInStock.length
  const coveredInStock  = Math.max(0, totalInStock - uncoveredCount)

  const rulesCount       = rulesTotal?.count  ?? 0
  const activeRulesCount = rulesActive?.count ?? 0

  const queuePending    = queueJobs?.filter(j => j.status === 'pending').length    ?? 0
  const queueProcessing = queueJobs?.filter(j => j.status === 'processing').length ?? 0
  const queueFailed     = queueJobs?.filter(j => j.status === 'failed').length     ?? 0

  const assetBreakdown = ALL_ASSET_TYPES.map((type, i) => ({
    type,
    count: assetBreakdownResult[i]?.count ?? 0,
  }))
  const maxAssetCount = Math.max(1, ...assetBreakdown.map(a => a.count))

  const reauthStoreCount = (reauthStores ?? []).filter(s => s.needs_reauth).length
  const needsReauth      = reauthStoreCount > 0
  const coveragePct      = totalInStock > 0 ? Math.round((coveredInStock / totalInStock) * 100) : 0

  return (
    <div style={{ fontFamily: 'var(--font-sans-family)', color: '#241A3D' }}>

      {/* Page heading */}
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'var(--font-heading-family)', fontSize: 22, fontWeight: 600, color: '#241A3D', margin: 0 }}>
          Dashboard
        </h1>
        <p style={{ fontSize: 13, color: '#6B6280', margin: '4px 0 0' }}>
          Your catalog creative automation overview
        </p>
      </div>

      {authError && <AuthErrorNotice reason={authError} />}

      {/* Reconnect banner — shown when any connected store needs reauth */}
      {needsReauth && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          background: '#FBE6E4', border: '1px solid #f0c3bf', borderRadius: 12,
          padding: '12px 14px', marginBottom: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <AlertTriangle size={16} color="#D6483F" style={{ marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#D6483F' }}>
                {reauthStoreCount} store{reauthStoreCount > 1 ? 's need' : ' needs'} reconnecting
              </div>
              <div style={{ fontSize: 12, color: '#a8483f', marginTop: 1 }}>
                Sync and generation are paused until it is reconnected.
              </div>
            </div>
          </div>
          <Link
            href="/dashboard/settings"
            style={{
              fontSize: 12.5, fontWeight: 600, color: '#D6483F',
              border: '1px solid #D6483F88', borderRadius: 8,
              padding: '6px 12px', whiteSpace: 'nowrap', textDecoration: 'none',
            }}
          >
            Reconnect
          </Link>
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        {[
          { label: 'Products synced',     value: productCount,  sub: `${storeList.length} connected store${storeList.length !== 1 ? 's' : ''}`, Icon: ShoppingBag },
          { label: 'Templates',           value: templateCount, sub: `${templateCount} active`,    Icon: Layers },
          { label: 'Rules',               value: rulesCount,    sub: `${activeRulesCount} active`, Icon: Zap },
          { label: 'Creatives generated', value: creativeCount, sub: creativeCount === 0 ? 'None yet' : 'Total generated', Icon: ImageIcon },
        ].map(({ label, value, sub, Icon }) => (
          <div key={label} style={{
            background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12.5, color: '#6B6280', fontWeight: 600 }}>{label}</span>
              <Icon size={15} color="#6B6280" />
            </div>
            <div style={{ fontSize: 25, fontWeight: 600, color: '#241A3D', marginTop: 6 }}>
              {value.toLocaleString('en-IN')}
            </div>
            <div style={{ fontSize: 11.5, color: '#6B6280', marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Main 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>

        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

          {/* Feed coverage */}
          <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#6B6280' }}>Feed coverage</span>
              {uncoveredCount > 0 && (
                <Link
                  href="/dashboard/creatives"
                  style={{
                    background: '#4B2E83', color: '#fff', fontSize: 12, fontWeight: 600,
                    borderRadius: 8, padding: '7px 12px', display: 'flex', alignItems: 'center',
                    gap: 6, textDecoration: 'none',
                  }}
                >
                  <Wand2 size={14} />
                  Generate {uncoveredCount} missing
                </Link>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 600, color: '#241A3D' }}>
                {coveredInStock}
                <span style={{ fontSize: 13, fontWeight: 400, color: '#6B6280' }}>/{totalInStock}</span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#6B6280' }}>{coveragePct}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 8, background: '#EFEAF9', overflow: 'hidden' }}>
              <div style={{ width: `${coveragePct}%`, height: '100%', background: '#4B2E83', transition: 'width 0.3s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#6B6280', marginTop: 8 }}>
              In-stock variants with a creative ready for the Meta feed
            </div>
          </div>

          {/* Generation queue */}
          <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6B6280', marginBottom: 12 }}>
              Generation queue
            </div>
            <div style={{ display: 'flex', gap: 24 }}>
              {[
                { label: 'Pending',    value: queuePending,    Icon: Clock,    iconBg: '#FBF9FF', iconColor: '#6B6280' },
                { label: 'Processing', value: queueProcessing, Icon: Loader2,  iconBg: '#EFEAF9', iconColor: '#4B2E83' },
                { label: 'Failed',     value: queueFailed,     Icon: X,        iconBg: '#FBE6E4', iconColor: '#D6483F' },
              ].map(({ label, value, Icon, iconBg, iconColor }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    width: 32, height: 32, borderRadius: '50%', background: iconBg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Icon size={15} color={iconColor} />
                  </span>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 600, color: '#241A3D', lineHeight: 1 }}>{value}</div>
                    <div style={{ fontSize: 11.5, color: '#6B6280', marginTop: 3 }}>{label}</div>
                  </div>
                </div>
              ))}
            </div>
            {queueFailed > 0 && (
              <Link
                href="/dashboard/creatives"
                style={{
                  fontSize: 12, fontWeight: 600, color: '#D6483F', marginTop: 10,
                  display: 'flex', alignItems: 'center', gap: 5, textDecoration: 'none',
                }}
              >
                <RefreshCw size={13} />
                Review and retry {queueFailed} failed job{queueFailed !== 1 ? 's' : ''}
              </Link>
            )}
          </div>

          {/* Recent activity */}
          <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#6B6280' }}>Recent activity</span>
              <Link href="/dashboard/creatives" style={{ fontSize: 12, fontWeight: 600, color: '#4B2E83', textDecoration: 'none' }}>
                View all →
              </Link>
            </div>
            {(!recentCreatives || recentCreatives.length === 0) ? (
              <p style={{ fontSize: 13, color: '#6B6280' }}>No creatives generated yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {(recentCreatives as RecentCreative[]).map((c, i) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '9px 0',
                      borderBottom: i < recentCreatives.length - 1 ? '1px solid #F0EDF7' : 'none',
                    }}
                  >
                    {c.url ? (
                      <img
                        src={c.url}
                        alt=""
                        style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: '#EFEAF9' }}
                      />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: '#EFEAF9', flexShrink: 0 }} />
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#241A3D', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.products?.title ?? 'Unknown product'}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#6B6280' }}>
                        {c.templates?.name ?? 'Creative'} ·{' '}
                        {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

          {/* Quick actions */}
          <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6B6280', marginBottom: 10 }}>Quick actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {[
                { label: 'Generate creatives', sub: 'Fill coverage gaps',      Icon: Wand2,    href: '/dashboard/creatives' },
                { label: 'New template',       sub: 'Design a layout',         Icon: Plus,     href: '/dashboard/templates' },
                { label: 'New rule',           sub: 'Automate template picks', Icon: Zap,      href: '/dashboard/rules' },
                { label: 'Store settings',     sub: 'Feed, sync, connection',  Icon: Settings, href: '/dashboard/settings' },
              ].map(({ label, sub, Icon, href }) => (
                <Link key={href} href={href} style={{ textDecoration: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <span style={{
                      width: 30, height: 30, borderRadius: 8, background: '#EFEAF9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <Icon size={15} color="#4B2E83" />
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#241A3D' }}>{label}</div>
                      <div style={{ fontSize: 11, color: '#6B6280' }}>{sub}</div>
                    </div>
                    <ArrowUpRight size={14} color="#6B6280" />
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Active store */}
          {activeStore && (
            <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#241A3D' }}>Active store</span>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: '#1E9E7C', background: '#E3F5EE',
                  borderRadius: 20, padding: '3px 10px',
                }}>
                  {activeStore.needs_reauth ? 'Needs reconnect' : 'Connected'}
                </span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#241A3D' }}>
                {activeStore.shop_name || activeStore.shop_domain}
              </div>
              <div style={{ fontSize: 12, color: '#6B6280', marginTop: 2 }}>{activeStore.shop_domain}</div>
              {activeStore.last_synced_at && (
                <div style={{ fontSize: 12, color: '#6B6280', marginTop: 4 }}>
                  Last synced {formatDistanceToNow(new Date(activeStore.last_synced_at), { addSuffix: true })}
                </div>
              )}
              {storeList.length > 1 && (
                <div style={{
                  fontSize: 11.5, color: '#6B6280', marginTop: 10, paddingTop: 10,
                  borderTop: '1px solid #F0EDF7',
                }}>
                  {storeList.length} stores connected — switch from the sidebar.
                </div>
              )}
            </div>
          )}

          {/* Asset breakdown — creatives generated per placement */}
          <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6B6280', marginBottom: 12 }}>
              Asset breakdown
            </div>
            {creativeCount === 0 ? (
              <p style={{ fontSize: 13, color: '#6B6280' }}>No creatives generated yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {assetBreakdown.map(({ type, count }) => (
                  <div key={type}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, color: '#241A3D' }}>
                        {ASSET_TYPE_CONFIG[type].label}
                        <span style={{ color: '#6B6280' }}> · {ASSET_TYPE_CONFIG[type].aspectRatio}</span>
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#241A3D' }}>{count}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 6, background: '#EFEAF9', overflow: 'hidden' }}>
                      <div style={{
                        width: `${(count / maxAssetCount) * 100}%`, height: '100%',
                        background: '#4B2E83', transition: 'width 0.3s',
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top templates */}
          <div style={{ background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#6B6280' }}>Top templates</span>
              <Link href="/dashboard/templates" style={{ fontSize: 12, fontWeight: 600, color: '#4B2E83', textDecoration: 'none' }}>
                View all →
              </Link>
            </div>
            {templateCount === 0 ? (
              <p style={{ fontSize: 13, color: '#6B6280' }}>No templates yet.</p>
            ) : (
              <p style={{ fontSize: 13, color: '#6B6280' }}>
                {templateCount} template{templateCount !== 1 ? 's' : ''} configured.
              </p>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}