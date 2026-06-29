import { useState } from 'react'
import { type LoaderFunctionArgs, redirect, useLoaderData, useSearchParams } from 'react-router'
import { api, ApiError } from '../lib/api'
import { safeNext } from '../lib/nav'
import type { Me, PublicConfig } from '../lib/types'
import { BlueprintField } from '@/components/BlueprintField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import '@/tailwind.css'

const ERRORS: Record<string, string> = {
  denied: 'Wrong door — Glance is restricted to approved Google Workspace accounts.',
  oauth: "Google sign-in didn't go through. Try again.",
  state: 'Sign-in session expired before it finished. Start over.',
  exchange: "Couldn't finish the handshake with Google. Try again.",
}

// Maps bootstrap route status codes to a human message for the first-run setup form.
const BOOTSTRAP_ERRORS: Record<number, string> = {
  401: 'That setup token is incorrect.',
  404: 'Setup is not available on this deployment.',
  410: 'This deployment already has an admin — setup is closed.',
  429: 'Too many attempts. Wait a bit and try again.',
}

const FEATURES = [
  {
    label: 'Google SSO, your domain only',
    detail: 'Your work Google login is the whole story — no new account, no shared password.',
  },
  {
    label: 'Drag-drop or CLI',
    detail: 'Drop a folder in the browser or run glance deploy. Same upload, same URL.',
  },
  {
    label: 'private · members · team',
    detail: 'Three visibility levels per site — from just you to everyone in your org.',
  },
  {
    label: '$0/month on Cloudflare',
    detail: 'Workers, R2, D1 and KV at the edge. No servers to patch, global by default.',
  },
]

const TERMINAL = [
  {
    prompt: 'glance deploy ./runbook --space infra --name deploy-guide',
    output: 'uploading 14 files…  ✓ live → glance.example.com/infra/deploy-guide · 0.4s',
  },
  {
    prompt: 'glance deploy ./design-system --visibility team',
    output: '✓ live → glance.example.com/frontend/design-system · team',
  },
  {
    prompt: 'glance list',
    output: 'infra/deploy-guide   team   glance.example.com/infra/deploy-guide',
  },
]

export async function loader({ request }: LoaderFunctionArgs) {
  const next = safeNext(new URL(request.url).searchParams.get('next'))
  try {
    await api.get<Me>('/api/auth/me')
    return redirect(next ?? '/dashboard') // already signed in — honor the return URL
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // Logged out: ask the server which login options to offer (Google vs. first-run setup).
      // Degrade gracefully — a config blip must never take down the login page itself.
      try {
        return await api.get<PublicConfig>('/api/config')
      } catch {
        return { googleEnabled: false, bootstrapAvailable: false } satisfies PublicConfig
      }
    }
    throw err
  }
}

export function Component() {
  const { googleEnabled, bootstrapAvailable } = useLoaderData() as PublicConfig
  const [params] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const error = params.get('error')
  const next = params.get('next')
  const hasAnyMethod = googleEnabled || bootstrapAvailable || import.meta.env.DEV

  return (
    <div className="dark relative min-h-screen w-full overflow-hidden bg-[#070b16] font-sans text-foreground antialiased">
      {/* centerpiece animated background */}
      <BlueprintField className="z-0" />
      {/* vignette: top light + bottom shade to seat the grid and lift the content */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% -10%, rgba(86,130,196,0.12), transparent 55%), radial-gradient(90% 90% at 50% 115%, rgba(0,0,0,0.6), transparent 60%)',
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-7 sm:px-8">
        <header className="bp-rise flex items-center justify-between">
          <div className="flex items-center gap-2.5 font-mono text-sm font-semibold tracking-tight">
            <span className="inline-block size-2.5 rounded-[3px] bg-primary shadow-[0_0_14px_2px_rgba(245,158,11,0.5)]" />
            glance
          </div>
          <span className="font-mono text-xs text-muted-foreground">self-hosted</span>
        </header>

        <main className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          {/* pitch */}
          <div>
            <div className="bp-rise font-mono text-sm" style={{ animationDelay: '60ms' }}>
              <span className="text-muted-foreground">~/work $</span>{' '}
              <span className="text-primary">glance</span>
            </div>
            <h1
              className="bp-rise mt-5 font-mono text-5xl font-semibold leading-[1.04] tracking-tight [text-shadow:0_2px_30px_rgba(7,11,22,0.85)] sm:text-6xl"
              style={{ animationDelay: '120ms' }}
            >
              Folder in.
              <br />
              URL out.
              <br />
              <span className="text-primary">No build step.</span>
            </h1>
            <p
              className="bp-rise mt-6 max-w-md text-base leading-relaxed text-muted-foreground"
              style={{ animationDelay: '200ms' }}
            >
              Glance is a self-hosted static host. Drop a folder of HTML, markdown, or assets — get a
              live URL in seconds. No bundler, no Docker, no deploy pipeline to babysit.
            </p>

            <ul
              className="bp-rise mt-9 grid gap-x-8 gap-y-5 sm:grid-cols-2"
              style={{ animationDelay: '280ms' }}
            >
              {FEATURES.map((f, i) => (
                <li key={f.label} className="flex gap-3">
                  <span className="mt-0.5 font-mono text-xs tabular-nums text-primary">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <div className="font-mono text-[13px] font-medium text-foreground">{f.label}</div>
                    <div className="mt-1 text-[13px] leading-snug text-muted-foreground">
                      {f.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* terminal + auth */}
          <div className="bp-rise flex flex-col gap-5" style={{ animationDelay: '360ms' }}>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0a1120]/80 shadow-2xl backdrop-blur-sm">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                <span className="size-3 rounded-full bg-white/15" />
                <span className="size-3 rounded-full bg-white/15" />
                <span className="size-3 rounded-full bg-white/15" />
                <span className="ml-2 font-mono text-xs text-muted-foreground">glance — zsh</span>
              </div>
              <div className="space-y-3 p-4 font-mono text-[12.5px] leading-relaxed">
                {TERMINAL.map((line) => (
                  <div key={line.prompt}>
                    <div className="flex gap-2">
                      <span className="shrink-0 select-none text-primary">$</span>
                      <span className="break-all text-foreground/90">{line.prompt}</span>
                    </div>
                    <div className="mt-1 break-all pl-4 text-muted-foreground">{line.output}</div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <span className="shrink-0 select-none text-primary">$</span>
                  <span className="bp-caret text-foreground/70" />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-card/70 p-6 backdrop-blur-sm">
              {error && <ErrorBanner className="mb-4">{ERRORS[error] ?? 'Sign-in error.'}</ErrorBanner>}
              {googleEnabled && (
                <Button
                  size="lg"
                  className="h-12 w-full gap-3 text-[15px] font-medium"
                  onClick={() => {
                    const qs = next ? `?next=${encodeURIComponent(next)}` : ''
                    window.location.href = `/api/auth/google${qs}`
                  }}
                >
                  <span className="flex size-6 items-center justify-center rounded bg-white">
                    <GoogleGlyph />
                  </span>
                  Sign in with Google
                </Button>
              )}

              {bootstrapAvailable && <SetupPanel next={next} withDivider={googleEnabled} />}

              {import.meta.env.DEV && (
                <Button
                  variant="outline"
                  className="mt-3 h-10 w-full font-mono text-xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    const res = await fetch('/api/auth/dev-login', { method: 'POST', credentials: 'include' })
                    if (res.ok) window.location.href = safeNext(next) ?? '/dashboard'
                    else setBusy(false)
                  }}
                >
                  {busy ? 'signing in…' : '› dev login (localhost)'}
                </Button>
              )}

              {!hasAnyMethod && (
                <p className="text-center text-sm text-muted-foreground">
                  No sign-in method is configured yet. Ask an administrator to finish setup.
                </p>
              )}

              <p className="mt-4 text-center text-xs text-muted-foreground">
                {googleEnabled
                  ? 'Approved Google Workspace accounts only · sessions expire after 24h'
                  : 'Sessions expire after 24h'}
              </p>
            </div>
          </div>
        </main>

        <footer
          className="bp-rise flex items-center justify-between font-mono text-xs text-muted-foreground"
          style={{ animationDelay: '440ms' }}
        >
          <span>$0/month · Workers + R2 + D1 + KV</span>
          <span className="hidden sm:inline">drop a folder, get a URL</span>
        </footer>
      </div>
    </div>
  )
}

// Shared destructive message banner (sign-in errors + setup errors).
function ErrorBanner({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-lg border border-destructive/40 bg-destructive/15 px-3.5 py-2.5 text-sm text-destructive${
        className ? ` ${className}` : ''
      }`}
    >
      {children}
    </div>
  )
}

// First-run setup: claim the first superadmin with the deploy's BOOTSTRAP_TOKEN. Posts the
// token in the body (POST /api/auth/bootstrap) — same-origin, so the route's CSRF check passes.
function SetupPanel({ next, withDivider }: { next: string | null; withDivider: boolean }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.post('/api/auth/bootstrap', { token })
      window.location.href = safeNext(next) ?? '/dashboard'
    } catch (e2) {
      const status = e2 instanceof ApiError ? e2.status : 0
      setErr(BOOTSTRAP_ERRORS[status] ?? 'Setup failed. Try again.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className={withDivider ? 'mt-5 border-t border-white/10 pt-5' : undefined}>
      <p className="mb-3 text-sm text-muted-foreground">
        First run? Enter the setup token printed by the deploy to claim the admin account.
      </p>
      {err && <ErrorBanner className="mb-3">{err}</ErrorBanner>}
      <Input
        type="password"
        autoComplete="off"
        placeholder="setup token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="h-11 font-mono"
      />
      <Button type="submit" size="lg" variant="outline" className="mt-3 h-11 w-full" disabled={!token || busy}>
        {busy ? 'setting up…' : 'Complete setup'}
      </Button>
    </form>
  )
}

// Official Google "G", set on a white tile so it reads cleanly on the amber CTA.
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <title>Google</title>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}
