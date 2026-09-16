import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { SHOPIFY_HOST_COOKIE } from '@/lib/shopify-host'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, {
              ...options,
              sameSite: 'none',
              secure: true,
              partitioned: true,
              path: '/',
            })
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // --- Shopify embedded app launch ---
  // These paths must NOT be blocked regardless of auth state.
  // /api/shopify/auth validates via HMAC, not Supabase session.
  // /api/shopify/install and /api/shopify/callback run the OAuth handshake
  // itself and sign a brand-new merchant in server-side before ever reaching
  // a page middleware would otherwise gate.
  const isShopifyAuthRoute =
    pathname.startsWith('/api/shopify/auth') ||
    pathname.startsWith('/api/shopify/install') ||
    pathname.startsWith('/api/shopify/callback')

  if (isShopifyAuthRoute) {
    return supabaseResponse
  }

  // --- Keep App Bridge configurable on every full page load ---
  // App Bridge reads `host` from the document URL. A refresh or a deep link
  // into /dashboard/* arrives without it, App Bridge throws "missing required
  // configuration fields: shop", window.shopify stays undefined, and session
  // tokens silently stop working. Re-attaching it from the cookie set at launch
  // makes that self-healing instead of a dead embedded session.
  if (pathname.startsWith('/dashboard') && !request.nextUrl.searchParams.has('host')) {
    const savedHost = request.cookies.get(SHOPIFY_HOST_COOKIE)?.value
    if (savedHost) {
      const url = request.nextUrl.clone()
      url.searchParams.set('host', savedHost)
      return NextResponse.redirect(url)
    }
  }

  // Protect dashboard routes — redirect to login if not authenticated
  if (!user && pathname.startsWith('/dashboard')) {
    // A shop param here means this is an embedded launch that lost its
    // session (expired, cookie dropped, etc.) — send it through OAuth+
    // auto-signin again instead of showing the email/password form a
    // Shopify-launched merchant was never supposed to see.
    const shop = request.nextUrl.searchParams.get('shop')
    if (shop) {
      const installUrl = new URL('/api/shopify/install', request.url)
      installUrl.searchParams.set('shop', shop)
      const host = request.nextUrl.searchParams.get('host')
      if (host) installUrl.searchParams.set('host', host)
      return NextResponse.redirect(installUrl)
    }

    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Redirect logged-in users away from auth pages
  if (user && (pathname === '/login' || pathname === '/signup' || pathname === '/login/signup')) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/cron).*)'],
}