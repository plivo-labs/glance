import { redirect, type ShouldRevalidateFunctionArgs } from 'react-router'

// The dashboard keeps UI state in the URL (?tab=, ?new=). React Router's default treats any
// search change as "re-run every matched loader", so routes whose loaders don't read the search
// string opt out of same-path search-only navigations with this predicate. Same-URL navigations
// keep the default — that's how revalidator.revalidate() still reaches them.
export function skipSearchOnlyRevalidation({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) return false
  return defaultShouldRevalidate
}

/** Href that opens the create-space dialog (?new=space on /dashboard), preserving the active
 *  ?tab= when already there — the one spelling of this intent for every navigator. */
export function newSpaceHref(location: { pathname: string; search: string }): string {
  const params = new URLSearchParams(location.pathname === '/dashboard' ? location.search : '')
  params.set('new', 'space')
  return `/dashboard?${params}`
}

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
