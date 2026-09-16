/**
 * GET /api/shopify/auth
 *
 * Embedded app launch handler.
 *
 * Auth:    HMAC signature over the query string (verified against
 *          SHOPIFY_CLIENT_SECRET) — this IS the auth check; no separate
 *          session cookie is required to reach this route.
 * Query:   shop, hmac (required), id_token (embedded launch token, optional),
 *          host, embedded (passed through to the redirect)
 * Returns: 302 redirect — to /api/shopify/install if the store isn't
 *          installed yet, otherwise to /dashboard (with auth_error set if the
 *          token exchange failed) or /login on an unrecoverable failure.
 *
 * Flow:
 * 1. Validate HMAC.
 * 2. Look up the store. Not installed -> classic OAuth install.
 * 3. Token exchange: trade the launch `id_token` for an EXPIRING offline access
 *    token and store it. (Shopify rejects the old non-expiring tokens.)
 * 4. Sign the store owner into Supabase SERVER-SIDE (verifyOtp on a generated
 *    magic-link hash) and write the auth cookies as SameSite=None; Secure;
 *    Partitioned so they survive inside Shopify's admin iframe.
 * 5. Redirect straight to /dashboard. No client login form, no supabase.co hop.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import crypto from 'crypto'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'
import { SHOPIFY_HOST_COOKIE } from '@/lib/shopify-host'
import { exchangeSessionTokenForOfflineToken } from '@/lib/shopify-token'

function adminClient() {
  return createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getAppOrigin(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_APP_URL
  if (env && !env.includes('localhost') && !env.includes('127.0.0.1')) {
    return env.replace(/\/$/, '')
  }
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  return host ? `${proto}://${host}` : request.nextUrl.origin
}

function verifyHmac(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get('hmac')
  if (!hmac) return false

  const pairs: string[] = []
  query.forEach((value, key) => {
    if (key !== 'hmac') pairs.push(`${key}=${value}`)
  })
  pairs.sort()

  const digest = crypto
    .createHmac('sha256', secret)
    .update(pairs.join('&'))
    .digest('hex')

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))
  } catch {
    return false
  }
}

/**
 * Redirect to /login while preserving every query param this request came in
 * with (shop, hmac, host, embedded, id_token, session, timestamp, locale...).
 * A bare `new URL('/login', request.url)` drops all of them, which lands the
 * merchant on /login with no `shop` — and that's exactly what stopped
 * (auth)/login/page.tsx's own shop-param recovery (redirect back into OAuth)
 * from ever firing, a real Shopify App Store review rejection.
 */
function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL('/login', request.url)
  loginUrl.search = request.nextUrl.search
  return NextResponse.redirect(loginUrl)
}

/**
 * Supabase server client that writes session cookies onto `response` with
 * SameSite=None so they're sent on requests inside the Shopify iframe.
 */
function sessionClient(request: NextRequest, response: NextResponse) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, {
              ...options,
              sameSite: 'none',
              secure: true,
              partitioned: true,
              path: '/',
            })
          })
        },
      },
    }
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')
  const hmac = searchParams.get('hmac')
  const idToken = searchParams.get('id_token') ?? ''

  if (!shop || !hmac) {
    return redirectToLogin(request)
  }

  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
  if (!shopRegex.test(shop)) {
    return new NextResponse('Invalid shop domain', { status: 400 })
  }

  if (!verifyHmac(searchParams, process.env.SHOPIFY_CLIENT_SECRET!)) {
    console.error('[shopify/auth] HMAC invalid for shop:', shop)
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const supabase = adminClient()

  const { data: store } = await supabase
    .from('stores')
    .select('id, user_id')
    .eq('shop_domain', shop)
    .maybeSingle()

  // Not installed yet — run OAuth install. host must ride along or it's lost
  // for the rest of the install chain — see install/route.ts's own comment on
  // why that broke App Bridge on a brand-new merchant's very first load.
  if (!store) {
    const installUrl = new URL('/api/shopify/install', request.url)
    installUrl.searchParams.set('shop', shop)
    const hostParam = searchParams.get('host')
    if (hostParam) installUrl.searchParams.set('host', hostParam)
    return NextResponse.redirect(installUrl.toString())
  }

  // --- 3. Token exchange: refresh to an expiring offline access token. ---
  //
  // Three things go wrong here if this block is careless, and all three did:
  //  1. needs_reauth was never cleared on success, so the "token expired"
  //     banner survived a perfectly good reconnect and could never clear.
  //  2. expires_in was discarded, leaving token_expires_at null — nothing could
  //     tell a fresh expiring token from a legacy non-expiring one.
  //  3. a failed exchange only reached a server log, so the app loaded normally
  //     with a dead token and the merchant had no idea why syncing failed.
  // Carries the reason a token refresh failed through to the dashboard, so the
  // merchant sees Shopify's actual message instead of it dying in a server log.
  let authError: string | null = null

  if (idToken) {
    try {
      const { access_token, scope, expires_in, refresh_token, refresh_token_expires_in } =
        await exchangeSessionTokenForOfflineToken(shop, idToken)

      await supabase
        .from('stores')
        .update({
          access_token,
          ...(scope ? { scope } : {}),
          needs_reauth: false,
          token_expires_at: expires_in
            ? new Date(Date.now() + expires_in * 1000).toISOString()
            : null,
          // Keeps background jobs authenticated past the 1-hour access token.
          ...(refresh_token ? { refresh_token } : {}),
          ...(refresh_token_expires_in
            ? {
                refresh_token_expires_at: new Date(
                  Date.now() + refresh_token_expires_in * 1000
                ).toISOString(),
              }
            : {}),
        })
        .eq('id', store.id)

      console.log(
        `[shopify/auth] token exchange OK shop=${shop} prefix=${access_token.slice(0, 6)} expires_in=${expires_in ?? 'none'}`
      )
    } catch (err: any) {
      // Flag the store so the UI keeps prompting a reconnect rather than
      // silently serving a token the Admin API will reject.
      authError = String(err?.message || err).slice(0, 300)
      console.error('[shopify/auth] token exchange failed:', authError)
      await supabase
        .from('stores')
        .update({ needs_reauth: true })
        .eq('id', store.id)
    }
  } else {
    // No id_token means this was not an embedded launch, so no refresh was even
    // attempted — worth saying out loud, because the symptom (stale token) is
    // identical to a failed exchange.
    authError = 'no_id_token'
  }

  // --- 4. Sign the owner into Supabase, server-side. ---
  const { data: userData, error: userError } =
    await supabase.auth.admin.getUserById(store.user_id)
  if (userError || !userData?.user?.email) {
    console.error('[shopify/auth] Cannot find user for store:', store.id, userError)
    return redirectToLogin(request)
  }

  const { data: linkData, error: linkError } =
    await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: userData.user.email,
    })

  const tokenHash = linkData?.properties?.hashed_token

  // Build the response we'll attach cookies to, then redirect to /dashboard.
  //
  // shop/host/embedded MUST survive this redirect. App Bridge reads them from
  // the document URL to configure itself; dropping them produced
  //   "App Bridge Next: missing required configuration fields: shop"
  // and left window.shopify undefined, which is why Shopify's embedded checks
  // never saw any App Bridge or session-token activity.
  const dashboardUrl = new URL('/dashboard', getAppOrigin(request))
  for (const key of ['shop', 'host', 'embedded'] as const) {
    const value = searchParams.get(key)
    if (value) dashboardUrl.searchParams.set(key, value)
  }
  if (authError) dashboardUrl.searchParams.set('auth_error', authError)
  const response = NextResponse.redirect(dashboardUrl)

  // Remembered so a later full page load (a refresh, or a deep link without
  // params) can restore `host` instead of breaking App Bridge again.
  const hostParam = searchParams.get('host')
  if (hostParam) {
    response.cookies.set(SHOPIFY_HOST_COOKIE, hostParam, {
      httpOnly: false,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    })
  }
  response.cookies.set(ACTIVE_STORE_COOKIE, store.id, {
    httpOnly: false,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })

  if (linkError || !tokenHash) {
    console.error('[shopify/auth] generateLink failed:', linkError)
    return redirectToLogin(request)
  }

  const session = sessionClient(request, response)
  // generateLink('magiclink') hashes can verify as either type depending on
  // project config; try both before giving up.
  let verified = false
  for (const type of ['email', 'magiclink'] as const) {
    const { error } = await session.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!error) {
      verified = true
      break
    }
  }

  if (!verified) {
    console.error('[shopify/auth] verifyOtp failed for store:', store.id)
    return redirectToLogin(request)
  }

  return response
}