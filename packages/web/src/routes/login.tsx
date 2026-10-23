import { useState } from 'react'
import { type LoaderFunctionArgs, redirect, useLoaderData, useSearchParams } from 'react-router'
import { api, ApiError } from '../lib/api'
import { safeNext } from '../lib/nav'
import type { Me, PublicConfig } from '../lib/types'
import { CopyButton } from '@/components/CopyButton'
import { BrandMark, ByPlivo, Eyebrow } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import '@/tailwind.css'

// Public source — surfaced in the header + footer so a self-hoster can find the repo.
const REPO_URL = 'https://github.com/plivo-labs/glance'

const ERRORS: Record<string, string> = {
  denied: 'Wrong door — Glance is restricted to approved work accounts.',
  oauth: "Sign-in didn't go through. Try again.",
  state: 'Sign-in session expired before it finished. Start over.',
  exchange: "Couldn't finish the handshake with your sign-in provider. Try again.",
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
    label: 'SSO for your domain',
    detail: 'Sign in with your work account — no new account, no shared password.',
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

// The real getting-started flow: install → login → deploy. `host` is this deployment's own
// origin so the demo mirrors what the visitor will actually see, not a placeholder domain.
function terminalSteps(installCmd: string, host: string) {
  return [
    { prompt: installCmd, output: '✓ installed glance → ~/.local/bin/glance' },
    { prompt: 'glance login', output: '✓ device approved in the browser · signed in' },
    { prompt: 'glance deploy ./site --visibility team', output: `✓ live → ${host}/you/site · 0.4s` },
  ]
}

export async function loader({ request }: LoaderFunctionArgs) {
  const next = safeNext(new URL(request.url).searchParams.get('next'))
  try {
    await api.get<Me>('/api/auth/me')
    return redirect(next ?? '/dashboard') // already signed in — honor the return URL
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // Logged out: ask the server which login options to offer (Google, OIDC, first-run setup).
      // Degrade gracefully — a config blip must never take down the login page itself.
      try {
        return await api.get<PublicConfig>('/api/config')
      } catch {
        return { googleEnabled: false, oidcName: null, bootstrapAvailable: false } satisfies PublicConfig
      }
    }
    throw err
  }
}

export function Component() {
  const { googleEnabled, oidcName, bootstrapAvailable } = useLoaderData() as PublicConfig
  const [params] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const error = params.get('error')
  const next = params.get('next')
  const oidcEnabled = oidcName !== null
  const provider = googleEnabled ? 'Google Workspace' : oidcName
  const hasAnyMethod = googleEnabled || oidcEnabled || bootstrapAvailable || import.meta.env.DEV
  const signIn = (provider: 'google' | 'oidc') => {
    const qs = next ? `?next=${encodeURIComponent(next)}` : ''
    window.location.href = `/api/auth/${provider}${qs}`
  }

  // This deployment's own origin drives the copy-paste install one-liner and the demo output,
  // so what a visitor copies is pre-pointed at THIS instance (mirrors GET /api/install).
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const host = origin.replace(/^https?:\/\//, '') || 'glance.example.com'
  const installCmd = `curl -fsSL ${origin}/api/install | sh`
  const terminal = terminalSteps(installCmd, host)

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground antialiased">
      {/* plivo.com texture: a fine dotted grid that fades out from the top, never a colour wash */}
      <div
        aria-hidden
        className="pl-dot-grid pointer-events-none absolute inset-0 z-0 opacity-40 [mask-image:radial-gradient(90%_70%_at_50%_0%,#000_35%,transparent_80%)]"
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-7 sm:px-8">
        <header className="pl-reveal flex items-center justify-between">
          <div className="flex items-center gap-2.5 font-display font-semibold text-[15px] tracking-[-0.02em]">
            <BrandMark />
            <span className="flex items-baseline gap-1.5">
              glance
              <ByPlivo />
            </span>
          </div>
          <div className="flex items-center gap-5 text-kicker text-muted-foreground">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <GithubGlyph />
              GitHub
            </a>
            <span>self-hosted</span>
          </div>
        </header>

        <main className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          {/* pitch, inside TechFrame-style bracket corners */}
          <div className="relative">
            <FrameCorners />
            <div className="pl-reveal flex" style={{ animationDelay: '95ms' }}>
              <Eyebrow index="~" meta="MIT">
                work $ glance
              </Eyebrow>
            </div>
            <h1 className="pl-reveal mt-6 text-display" style={{ animationDelay: '190ms' }}>
              Artifacts for
              <br />
              every agent.
            </h1>
            <p
              className="pl-reveal mt-6 max-w-md text-body-lg text-muted-foreground"
              style={{ animationDelay: '285ms' }}
            >
              An open-source alternative to Claude Artifacts. Any agent ships a self-contained page or app to a live URL
              — then you review it in the browser and it fixes itself. No bundler, no Docker, no deploy pipeline to
              babysit.
            </p>

            {/* spec grid: 1px hairline gaps over the border colour, mono index per cell */}
            <ul
              className="pl-reveal mt-10 grid gap-px overflow-hidden rounded border bg-border sm:grid-cols-2"
              style={{ animationDelay: '380ms' }}
            >
              {FEATURES.map((f, i) => (
                <li key={f.label} className="flex flex-col gap-1.5 bg-background p-4">
                  <span className="text-kicker text-foreground/70 tabular-nums">
                    [{String(i + 1).padStart(2, '0')}]
                  </span>
                  <span className="font-medium text-foreground text-sm">{f.label}</span>
                  <span className="text-muted-foreground text-s-400">{f.detail}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* terminal + auth */}
          <div className="pl-reveal flex flex-col gap-5" style={{ animationDelay: '475ms' }}>
            <div className="overflow-hidden rounded border bg-surface">
              <div className="flex items-center gap-2 border-b px-4 py-2.5">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex size-2 rounded-full bg-brand" />
                </span>
                <span className="ml-1 font-mono text-muted-foreground text-xs">glance — zsh</span>
                <CopyButton
                  text={installCmd}
                  label="copy install"
                  copiedMessage="Install command copied"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground [&_svg]:size-3"
                />
              </div>
              <div className="space-y-3 bg-code p-4 font-mono text-[12.5px] text-code-foreground leading-relaxed">
                {terminal.map((line) => (
                  <div key={line.prompt}>
                    <div className="flex gap-2">
                      <span className="shrink-0 select-none text-muted-foreground">$</span>
                      <span className="break-all">{line.prompt}</span>
                    </div>
                    <div className="mt-1 break-all pl-4 text-muted-foreground">{line.output}</div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <span className="shrink-0 select-none text-muted-foreground">$</span>
                  <span className="pl-caret text-foreground/70" />
                </div>
              </div>
            </div>

            <div className="rounded border bg-card p-6">
              {error && <ErrorBanner className="mb-4">{ERRORS[error] ?? 'Sign-in error.'}</ErrorBanner>}
              {oidcEnabled && (
                <Button size="lg" className="h-11 w-full" onClick={() => signIn('oidc')}>
                  Sign in with {oidcName}
                </Button>
              )}

              {googleEnabled && (
                <Button
                  size="lg"
                  variant={oidcEnabled ? 'outline' : 'default'}
                  className={cn('h-11 w-full gap-3', oidcEnabled && 'mt-3')}
                  onClick={() => signIn('google')}
                >
                  <span className="flex size-6 items-center justify-center rounded-sm bg-white">
                    <GoogleGlyph />
                  </span>
                  Sign in with Google
                </Button>
              )}

              {bootstrapAvailable && <SetupPanel next={next} withDivider={googleEnabled || oidcEnabled} />}

              {import.meta.env.DEV && (
                <Button
                  variant="outline"
                  className="mt-3 h-10 w-full"
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
                <p className="text-center text-muted-foreground text-sm">
                  No sign-in method is configured yet. Ask an administrator to finish setup.
                </p>
              )}

              <p className="mt-4 text-center text-muted-foreground text-xs">
                {provider ? `Approved ${provider} accounts only · sessions expire after 24h` : 'Sessions expire after 24h'}
              </p>
            </div>
          </div>
        </main>

        <footer
          className="pl-reveal flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-kicker text-muted-foreground"
          style={{ animationDelay: '570ms' }}
        >
          <span>$0/month · Workers + R2 + D1 + KV</span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <GithubGlyph />
            View source
          </a>
        </footer>
      </div>
    </div>
  )
}

// TechFrame-style L-bracket corners (plivo.com's precision frame), in currentColor at low opacity.
// Decorative: hidden below 640px so small screens stay clean.
function FrameCorners() {
  const corner = 'absolute size-3 border-foreground/25'
  return (
    <div aria-hidden className="pointer-events-none absolute -inset-6 hidden sm:block">
      <span className={`${corner} top-0 left-0 border-t border-l`} />
      <span className={`${corner} top-0 right-0 border-t border-r`} />
      <span className={`${corner} bottom-0 left-0 border-b border-l`} />
      <span className={`${corner} right-0 bottom-0 border-r border-b`} />
    </div>
  )
}

// Shared destructive message banner (sign-in errors + setup errors).
function ErrorBanner({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`rounded border border-destructive/40 bg-destructive/[0.12] px-3.5 py-2.5 text-destructive text-sm${
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
    <form onSubmit={submit} className={withDivider ? 'mt-5 border-t pt-5' : undefined}>
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

// GitHub mark — lucide 1.x dropped brand icons, so this is inlined (like GoogleGlyph).
function GithubGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
      <title>GitHub</title>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02.8-.22 1.65-.33 2.5-.33.85 0 1.7.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .27.18.58.69.48A10.01 10.01 0 0 0 22 12c0-5.52-4.48-10-10-10z"
      />
    </svg>
  )
}

// Official Google "G", set on a white tile so it reads cleanly on the ink (and hover-blue) CTA.
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
