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
 * Returns: 302 redirect to /dashboard on success, or /login?error=google_auth_failed
 *          on any failure (missing code, exchange error).
 *
 * Cookies are written directly onto the redirect response (not via
 * next/headers' cookies()) with SameSite=None; Secure; Partitioned — the
 * same pattern /api/shopify/auth's sessionClient() already uses, so a
 * merchant who reaches this from inside Shopify's embedded iframe (Google
 * sign-in opened in a new tab, then closed) still gets a session cookie the
 * embedded app's own requests can actually read.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

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
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const response = NextResponse.redirect(`${origin}/dashboard`)
    const supabase = sessionClient(request, response)
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return response
    }
    console.error('[auth/callback] exchangeCodeForSession failed:', error.message)
  }

  // Missing code, or the exchange failed — back to login with a visible error.
  return NextResponse.redirect(`${origin}/login?error=google_auth_failed`)
}
