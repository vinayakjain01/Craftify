'use client'

/**
 * GET /auth/google-start
 *
 * Transient page whose only job is to call signInWithOAuth from a genuine
 * top-level browsing context.
 *
 * Why this page exists: signInWithOAuth generates a PKCE code_verifier and
 * stashes it in this origin's localStorage before redirecting to Google.
 * When Shopify's admin embeds the app in an iframe, that iframe is a
 * third-party context, so browsers with storage partitioning (Chrome CHIPS,
 * Safari ITP, Firefox Total Cookie Protection) give it a SEPARATE localStorage
 * partition from a plain top-level tab at the same origin — even though both
 * are craft-ify.vercel.app. Calling signInWithOAuth inside the iframe and
 * then opening Google in a new tab (the previous approach) wrote the
 * verifier into the iframe's partition; the new tab's own partition never
 * saw it, so /auth/callback's exchangeCodeForSession always failed with
 * google_auth_failed. Initiating the OAuth call from inside the new tab
 * itself keeps the verifier and the callback in the same partition.
 */
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function GoogleStartPage() {
  const [status, setStatus] = useState('Connecting to Google…')

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    }).then(({ error }) => {
      if (error) setStatus('Failed to connect to Google. Please close this tab and try again.')
    })
    // signInWithOAuth navigates the browser away to Google on success — this
    // page's own UI only ever renders long enough to show that or an error.
  }, [])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#6B6280' }}>{status}</p>
    </div>
  )
}
