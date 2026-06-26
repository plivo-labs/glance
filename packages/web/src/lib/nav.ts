import { redirect } from 'react-router'

// Post-login return-URL helpers. The OAuth round-trip carries the intended path as a
// `next` query param; these keep it same-origin so it can't become an open redirect.

/** Root-relative paths only — blocks protocol-relative (`//evil.com`) and `/\evil.com`. */
export function safeNext(next: string | null | undefined): string | null {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  return next
}

/** Redirect to /login, preserving the current location as `?next=` so login returns here. */
export function toLogin(request: Request): Response {
  const url = new URL(request.url)
  return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
}
