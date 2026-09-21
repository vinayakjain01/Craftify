'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { GoogleIcon } from '@/components/ui/google-icon'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleMessage, setGoogleMessage] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  // Tears down the popup-tab message listener + its timeout. Ref rather than
  // state since it's plumbing for an in-flight async flow, not render input.
  const googlePopupCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      googlePopupCleanupRef.current?.()
    }
  }, [])

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
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      })
      if (error) {
        setError(error.message)
        setGoogleLoading(false)
      }
    }
  }

  async function handleSignup() {
    setLoading(true)
    setError('')
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    })
    if (error) {
      setError(error.message)
    } else if (data.session) {
      // "Confirm email" is off for this project, so signUp() already returns
      // a live session — go straight to the dashboard instead of a
      // "check your email" dead end nobody can act on inside an embedded
      // Shopify iframe (there's no inbox to check from in there).
      router.push('/dashboard')
    } else {
      // Confirmation is still required (no session came back) — this is the
      // only case where "check your email" is actually actionable.
      setSuccess(true)
    }
    setLoading(false)
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Check your email</CardTitle>
            <CardDescription>We sent a confirmation link to {email}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Link href="/login"><Button variant="outline">Back to login</Button></Link>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
          <CardDescription>Start automating your catalog creatives</CardDescription>
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
            {googleLoading ? 'Redirecting to Google…' : 'Sign up with Google'}
          </Button>
          {googleMessage && (
            <p className="text-sm text-center text-muted-foreground">{googleMessage}</p>
          )}

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">or create with email</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input id="name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Vinayak Jain" disabled={googleLoading}/>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" disabled={googleLoading}/>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min 8 characters" disabled={googleLoading}/>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button className="w-full" onClick={handleSignup} disabled={loading || googleLoading}>
            {loading ? 'Creating account…' : 'Create account'}
          </Button>
          <p className="text-sm text-muted-foreground text-center">
            Already have an account? <Link href="/login" className="underline">Sign in</Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}