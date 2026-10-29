'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { LayoutDashboard, ShoppingBag, Layers, Zap, ImageIcon, Settings, LogOut, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StoreSwitcher } from '@/components/dashboard/store-switcher'
import { CraftifyLogo } from '@/components/brand/craftify-logo'

interface StoreLite {
  id: string
  shop_name: string | null
  shop_domain: string
  feed_token: string | null
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/products', label: 'Products', icon: ShoppingBag },
  { href: '/dashboard/templates', label: 'Templates', icon: Layers },
  { href: '/dashboard/rules', label: 'Rules Engine', icon: Zap },
  { href: '/dashboard/creatives', label: 'Creatives', icon: ImageIcon },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
]

/**
 * The store's Meta feed URL, pinned above Sign out so it is reachable from
 * every screen — this replaces the old Meta section, which existed mainly to
 * display this one string.
 *
 * Built client-side from the active store rather than fetched: the token is
 * already in props and the URL is pure string assembly, so a round trip would
 * buy nothing.
 */
function FeedUrlFooter({ store }: { store: StoreLite | null }) {
  const [copied, setCopied] = useState(false)

  if (!store?.feed_token) return null

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const feedUrl = `${origin}/api/feed/${store.id}?token=${store.feed_token}&format=csv`

  async function copy() {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="border-t p-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Your feed URL</p>
      <div className="flex items-center gap-1.5">
        <code
          className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground"
          title={feedUrl}
        >
          /api/feed/{store.id.slice(0, 8)}…
        </code>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={copy}
          title="Copy feed URL"
          aria-label="Copy feed URL"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export function Sidebar({
  stores = [],
  activeStoreId = null,
}: {
  stores?: StoreLite[]
  activeStoreId?: string | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside style={{
      width: 216, flexShrink: 0,
      background: '#FBF9FF', borderRight: '1px solid #E7E2F0',
      display: 'flex', flexDirection: 'column', height: '100vh',
      fontFamily: 'var(--font-sans-family)',
    }}>

      {/* Logo — kept as the existing CraftifyLogo component, just restyled wrapper */}
      <div style={{ padding: '18px 18px 16px', borderBottom: '1px solid #E7E2F0' }}>
        <CraftifyLogo markClassName="h-7 w-7" />
      </div>

      {/* Store switcher — existing component, just wrapped */}
      <div style={{ borderBottom: '1px solid #E7E2F0' }}>
        <StoreSwitcher stores={stores} activeStoreId={activeStoreId} />
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                borderRadius: 10, padding: '9px 10px',
                background: active ? '#EFEAF9' : 'transparent',
                color: active ? '#4B2E83' : '#6B6280',
                fontWeight: active ? 600 : 400,
                fontSize: 13.5,
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}>
                <Icon size={16} />
                {label}
              </div>
            </Link>
          )
        })}
      </nav>

      {/* Feed URL footer — existing component, unchanged */}
      <FeedUrlFooter store={stores.find(s => s.id === activeStoreId) ?? null} />

      {/* Sign out */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #E7E2F0' }}>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', padding: '8px 10px', borderRadius: 10,
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#6B6280', fontSize: 13.5, fontFamily: 'inherit',
          }}
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>

      {/* Legal links — reachable from every authenticated screen, not just
          the logged-out login/signup forms. */}
      <div style={{
        padding: '0 14px 12px',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, color: '#9B93AC',
      }}>
        <Link href="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
        <span>·</span>
        <Link href="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
      </div>
    </aside>
  )
}