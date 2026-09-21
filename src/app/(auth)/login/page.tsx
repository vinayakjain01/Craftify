'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { GoogleIcon } from '@/components/ui/google-icon'

// useSearchParams() requires a Suspense boundary above it during static
// rendering — otherwise the build bails with "should be wrapped in a
// suspense boundary" on this exact page.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}

function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleMessage, setGoogleMessage] = useState('')
  const [error, setError] = useState('')
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()
  // Tears down the popup-tab message listener + its timeout. Ref rather than
  // state since it's plumbing for an in-flight async flow, not render input.
  const googlePopupCleanupRef = useRef<(() => void) | null>(null)

  // Stop listening for the popup-tab's session if this page unmounts first
  // (merchant navigates away before finishing Google sign-in elsewhere).
  useEffect(() => {
    return () => {
      googlePopupCleanupRef.current?.()
    }
  }, [])

  // A shop param on THIS page means something upstream (a stale bookmark, a
  // dropped session mid-flow) landed a Shopify-launched merchant on the email
  // form instead of completing OAuth — restart it instead of asking for
  // credentials they were never supposed to need.
  useEffect(() => {
    const shop = searchParams.get('shop')
    if (shop) {
      const installUrl = new URL('/api/shopify/install', window.location.origin)
      installUrl.searchParams.set('shop', shop)
      const host = searchParams.get('host')
      if (host) installUrl.searchParams.set('host', host)
      window.location.href = installUrl.toString()
      return
    }
    if (searchParams.get('error') === 'google_auth_failed') {
      // Deferred a tick: setState directly in an effect body is rejected by
      // the React Compiler lint rule (matches the pattern already used for
      // the debounced effects elsewhere in this codebase).
      setTimeout(() => setError('Google sign-in failed. Please try again.'), 0)
    }
  }, [searchParams])

  async function handleGoogleSignIn() {
    setGoogleLoading(true)
    setError('')
    setGoogleMessage('')

    const isInIframe = (() => {
      try { return window.self !== window.top } catch { return true }
    })()

    if (isInIframe) {
      // Open OUR OWN /auth/google-start in a new tab — rather than calling
      // signInWithOAuth here and opening ITS returned URL — so the PKCE
      // code_verifier signInWithOAuth stashes in localStorage is written and
      // later read back in the SAME top-level browsing context. Doing it
      // from inside this iframe put the verifier in the iframe's own
      // storage-partitioned localStorage (Shopify admin is a third-party
      // context here); the new tab's separate partition never saw it, so
      // /auth/callback's code exchange always failed with google_auth_failed.
      window.open('/auth/google-start', '_blank', 'width=520,height=620')
      setGoogleLoading(false)
      setGoogleMessage("Google sign-in opened in a new tab — return here once you've signed in.")

      // The popup's /auth/callback posts its session tokens back via
      // window.opener.postMessage once it's done — NOT a poll of
      // supabase.auth.getSession() in this frame, which was the earlier
      // (still broken) approach: that reads THIS frame's own storage
      // partition, and the popup's session cookie lands in ITS OWN partition
      // (admin.shopify.com vs. craft-ify.vercel.app are different top-level
      // sites) — the two never share state to poll for. postMessage crosses
      // that boundary because it's a live window-reference call, not a
      // shared-storage read.
      let settled = false
      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        window.removeEventListener('message', onMessage)
        setGoogleMessage('Timed out waiting for sign-in. Please refresh and try again.')
      }, 3 * 60 * 1000)

      async function onMessage(event: MessageEvent) {
        if (event.origin !== window.location.origin) return
        if (event.data?.type !== 'craftify_session_ready' || settled) return
        settled = true
        clearTimeout(timeoutId)
        window.removeEventListener('message', onMessage)

        setGoogleMessage('Setting up your session…')
        try {
          // Re-issues the session cookie from these raw tokens, but from
          // THIS frame's own request — so the resulting Set-Cookie lands in
          // the iframe's partition instead of the popup's.
          const res = await fetch('/api/auth/set-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              access_token: event.data.access_token,
              refresh_token: event.data.refresh_token,
            }),
            credentials: 'include',
          })
          if (!res.ok) throw new Error('Session exchange failed')
          // Hard reload, not router.push, so App Bridge and middleware
          // re-initialize against the freshly-set cookie.
          window.location.href = '/dashboard'
        } catch {
          setGoogleMessage('Sign-in succeeded but session setup failed — please refresh.')
        }
      }

      window.addEventListener('message', onMessage)
      googlePopupCleanupRef.current = () => {
        clearTimeout(timeoutId)
        window.removeEventListener('message', onMessage)
      }
    } else {
      // Not embedded — Google works fine as a normal top-level redirect.
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      })
      if (error) {
        setError(error.message)
        setGoogleLoading(false)
      }
      // Browser navigates to Google automatically on success.
    }
  }

  async function handleLogin() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
    } else {
      router.push('/dashboard')
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Enter your credentials to access your dashboard</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={handleGoogleSignIn}
            disabled={googleLoading || loading}
          >
            <GoogleIcon />
            {googleLoading ? 'Redirecting to Google…' : 'Continue with Google'}
          </Button>
          {googleMessage && (
            <p className="text-sm text-center text-muted-foreground">{googleMessage}</p>
          )}

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" disabled={googleLoading}/>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" disabled={googleLoading}/>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button className="w-full" onClick={handleLogin} disabled={loading || googleLoading}>
            {loading ? 'Signing in…' : 'Sign in with email'}
          </Button>
          <p className="text-sm text-muted-foreground text-center">
            No account? <Link href="/login/signup" className="underline">Sign up</Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}