/**
 * @module client
 *
 * Supabase client factory for browser/client-component code.
 *
 * RESPONSIBILITIES:
 *   - createClient — a Supabase client authenticated via the browser's cookies/local storage (anon key, RLS-scoped)
 */

import { createBrowserClient } from '@supabase/ssr'

/**
 * Create a Supabase client for use in client components (anon key, browser
 * session).
 *
 * cookieOptions forces SameSite=None; Secure; Partitioned on every cookie
 * this client's own document.cookie writes use (signInWithPassword, signUp,
 * signInWithOAuth, ...) — without it, @supabase/ssr's default attributes
 * (effectively SameSite=Lax) get silently dropped by the browser when this
 * runs inside Shopify's embedded admin iframe, which is a third-party
 * context from the browser's point of view. The call would appear to
 * succeed — Supabase returns a session object — but no cookie survives to
 * back it, so the very next request still looks logged out. Every
 * server-side cookie write in this app's Shopify auth flow already uses
 * these same attributes (see /api/shopify/auth's sessionClient()); this is
 * the one client-side gap that was missing them.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: {
        sameSite: 'none',
        secure: true,
        partitioned: true,
        path: '/',
      },
    }
  )
}