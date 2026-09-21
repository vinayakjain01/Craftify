/**
 * POST /api/auth/set-session
 *
 * Writes a session cookie into THIS request's own storage partition from a
 * pair of tokens obtained elsewhere.
 *
 * Why this exists: Google sign-in from inside Shopify's embedded admin opens
 * a popup tab to complete OAuth (Google refuses to render inside an iframe;
 * see (auth)/login/page.tsx). That popup's own session cookie lands in ITS
 * partition (top-level site = craft-ify.vercel.app), which the Shopify
 * iframe (top-level site = admin.shopify.com) can never read — storage
 * partitioning keeps them fully separate even though both are the same
 * origin. The popup's /auth/callback posts the raw tokens back to the
 * iframe via window.opener.postMessage (not a shared-storage mechanism, so
 * it crosses the partition boundary fine); the iframe then calls this
 * endpoint from its OWN request context so the resulting Set-Cookie lands
 * in ITS partition instead.
 *
 * Auth:    None checked directly — supabase.auth.setSession validates the
 *          tokens against Supabase itself; a forged/expired pair is
 *          rejected there, not by this route.
 * Body:    { access_token: string, refresh_token: string }
 * Returns: { ok: true } on success; { error } (400/401) on failure.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function POST(request: NextRequest) {
  const { access_token, refresh_token } = await request.json()
  if (!access_token || !refresh_token) {
    return NextResponse.json({ error: 'Missing tokens' }, { status: 400 })
  }

  const response = NextResponse.json({ ok: true })

  const supabase = createServerClient(
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

  const { error } = await supabase.auth.setSession({ access_token, refresh_token })
  if (error) return NextResponse.json({ error: error.message }, { status: 401 })

  return response
}
