/**
 * GET /auth/callback
 *
 * OAuth code-exchange landing point for Supabase's third-party providers
 * (currently Google). Supabase redirects here with ?code=... after the user
 * approves the provider's consent screen; this exchanges that code for a
 * session and lands the user on /dashboard, already signed in.
 *
 * Auth:    None checked directly — exchangeCodeForSession IS the auth check;
 *          a missing/invalid/expired code simply fails the exchange.
 * Query:   code (required)
 * Returns: on success, a tiny HTML page that, if opened as a popup from
 *          inside Shopify's embedded admin (see (auth)/login/page.tsx),
 *          posts the session tokens back to window.opener and closes
 *          itself — or redirects to /dashboard when not a popup. 302 to
 *          /login?error=google_auth_failed on any failure (missing code,
 *          exchange error).
 *
 * Cookies are written directly onto the response (not via next/headers'
 * cookies()) with SameSite=None; Secure; Partitioned — the same pattern
 * /api/shopify/auth's sessionClient() already uses. That cookie lands in
 * THIS TAB's own storage partition, which is fine for a normal top-level
 * visit but useless to the Shopify iframe that opened this as a popup —
 * the iframe's admin.shopify.com top-level site puts it in a completely
 * separate partition. window.opener.postMessage (below) is what actually
 * hands the session to the iframe; see (auth)/login/page.tsx and
 * /api/auth/set-session/route.ts for the receiving half.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

type PendingCookie = { name: string; value: string; options: Record<string, unknown> }

/**
 * A Supabase server client whose cookie writes are collected into `sink`
 * rather than applied to a response immediately — this route doesn't know
 * the final response (HTML body needs the session's tokens first) until
 * after the exchange runs, and a NextResponse's Set-Cookie headers can't be
 * copied onto a different response via Object.fromEntries(headers) without
 * silently collapsing multiple Set-Cookie entries into one.
 */
function sessionClient(request: NextRequest, sink: PendingCookie[]) {
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
            sink.push({
              name,
              value,
              options: { ...options, sameSite: 'none', secure: true, partitioned: true, path: '/' },
            })
          })
        },
      },
    }
  )
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const pendingCookies: PendingCookie[] = []
    const supabase = sessionClient(request, pendingCookies)
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      const { data: { session } } = await supabase.auth.getSession()

      // Handing the tokens to window.opener via postMessage (rather than a
      // BroadcastChannel, which is itself one of the browser storage APIs
      // partitioned by top-level site — the exact partition boundary this
      // whole popup flow exists to cross) is what actually reaches the
      // iframe: postMessage works off a live window-object reference, not
      // shared storage, so it's unaffected by admin.shopify.com and this
      // tab being in separate partitions. Falls back to a plain dashboard
      // redirect when this wasn't opened as a popup at all — the cookie
      // set below (this tab's own partition) is what backs that case.
      const html = `<!doctype html>
<html><body>
<script>
  var payload = {
    type: 'craftify_session_ready',
    access_token: ${JSON.stringify(session?.access_token ?? '')},
    refresh_token: ${JSON.stringify(session?.refresh_token ?? '')}
  };
  if (window.opener) {
    window.opener.postMessage(payload, ${JSON.stringify(origin)});
    setTimeout(function() { window.close() }, 300);
  } else {
    window.location.href = '/dashboard';
  }
</script>
<p>Signed in — this tab will close automatically.</p>
</body></html>`

      const response = new NextResponse(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
      for (const c of pendingCookies) response.cookies.set(c.name, c.value, c.options)
      return response
    }
    console.error('[auth/callback] exchangeCodeForSession failed:', error.message)
  }

  // Missing code, or the exchange failed — back to login with a visible error.
  return NextResponse.redirect(`${origin}/login?error=google_auth_failed`)
}
