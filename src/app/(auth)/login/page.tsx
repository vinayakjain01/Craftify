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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Stop polling for the popup-tab's session if this page unmounts first
  // (merchant navigates away before finishing Google sign-in elsewhere).
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
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

    // skipBrowserRedirect: get the consent-screen URL back instead of Supabase
    // auto-navigating this frame to it — Google refuses to render inside
    // Shopify's admin iframe (403: "you do not have access to this page"),
    // so whether we can use that URL directly depends on being embedded.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        skipBrowserRedirect: true,
      },
    })

    if (error || !data?.url) {
      setError(error?.message ?? 'Google sign-in failed. Please try again.')
      setGoogleLoading(false)
      return
    }

    const isInIframe = (() => {
      try { return window.self !== window.top } catch { return true }
    })()

    if (isInIframe) {
      // Open Google's consent screen in a real top-level tab, not nested in
      // Shopify's iframe, so it's actually allowed to render.
      window.open(data.url, '_blank')
      setGoogleLoading(false)
      setGoogleMessage("Google sign-in opened in a new tab — come back here once you've signed in.")

      // /auth/callback (running in that new tab) writes the session cookie;
      // once it lands, this frame picks it up and moves on on its own.
      pollRef.current = setInterval(async () => {
        const { data: { session } } = await supabase.auth.getSession()
        if (session) {
          if (pollRef.current) clearInterval(pollRef.current)
          router.push('/dashboard')
        }
      }, 2000)

      // Give up after 3 minutes rather than polling forever if the tab was
      // never completed.
      setTimeout(() => {
        if (pollRef.current) clearInterval(pollRef.current)
      }, 3 * 60 * 1000)
    } else {
      // Not embedded — Google works fine as a normal top-level redirect.
      window.location.href = data.url
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