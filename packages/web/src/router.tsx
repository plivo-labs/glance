import { Link, type LoaderFunctionArgs, type RouteObject, redirect, useRouteError } from 'react-router'
import { AppShell } from './components/AppShell'
import { Button } from './components/ui/button'
import { api, ApiError } from './lib/api'
import { skipSearchOnlyRevalidation } from './lib/nav'
import { EMPTY_NOTIFICATIONS, type RootData, notifications } from './lib/notifications'
import type { Me } from './lib/types'
import { EMPTY_WHATS_NEW, whatsNew } from './lib/whatsNew'

// Root loader fetches identity ONCE before render (replaces a mount useEffect). It does
// NOT redirect — the login page must render logged-out; protected route loaders guard
// themselves. Notifications ride along as a DEFERRED promise (not awaited — awaiting would block
// the first paint of every shell route); the Bell/inbox consume it via <Await>. Skipped (resolved
// empty) when logged out, and a failed fetch degrades to empty so it never breaks the shell.
async function rootLoader(): Promise<RootData> {
  let user: Me | null
  try {
    user = await api.get<Me>('/api/auth/me')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) user = null
    else throw err
  }
  const list = user ? notifications.list().catch(() => EMPTY_NOTIFICATIONS) : Promise.resolve(EMPTY_NOTIFICATIONS)
  const news = user ? whatsNew.list().catch(() => EMPTY_WHATS_NEW) : Promise.resolve(EMPTY_WHATS_NEW)
  return { user, notifications: list, whatsNew: news }
}

function RootError() {
  const error = useRouteError()
  const status = error instanceof ApiError ? error.status : (error as { status?: number })?.status
  const map: Record<number, { title: string; body: string }> = {
    401: { title: 'Sign in required', body: 'You need to sign in to view this.' },
    403: { title: "You don't have access", body: 'This site is private or restricted.' },
    404: { title: 'Not found', body: "That page or site doesn't exist." },
    410: { title: 'Site archived', body: 'This site has been archived by an admin.' },
  }
  const info = (status && map[status]) || { title: 'Something went wrong', body: 'Please try again.' }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="font-mono text-6xl font-semibold text-primary">{status ?? '!'}</div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{info.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{info.body}</p>
      <Button asChild className="mt-6">
        <Link to="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  )
}

// Re-export for child loaders that want to enforce auth.
export function requireUser(user: Me | null): Me {
  if (!user) throw redirect('/login')
  return user
}
export { rootLoader as _rootLoader }
export type { LoaderFunctionArgs }

// Split out from the entry file (main.tsx) so a test can assert on route ORDER without importing
// the createRoot/render side effect. See router.test.ts.
export const routeConfig: RouteObject[] = [
  // Login is a standalone, full-bleed route (its own dark Blueprint hero) outside the shell.
  { path: '/login', lazy: () => import('./routes/login') },
  // Site preview is full-bleed too — a chrome-less, full-screen iframe (opened in a new tab).
  // Lives outside the shell so there's no header/nav; loader 401 → /login, 403/404/410 → RootError.
  // The trailing `*` carries an optional in-site file path (`/space/site/docs/page.html`) so a
  // deep link / the directory-listing fallback points the iframe at that file and the URL reflects it.
  { path: '/:space/:site/*', lazy: () => import('./routes/viewer'), ErrorBoundary: RootError },
  {
    path: '/',
    id: 'root',
    Component: AppShell,
    loader: rootLoader,
    // This loader AWAITS /api/auth/me and its promises feed the Bell/WhatsNew <Await>s — a
    // search-only re-run would block the navigation and flash those badges to zero.
    shouldRevalidate: skipSearchOnlyRevalidation,
    ErrorBoundary: RootError,
    children: [
      { index: true, loader: () => redirect('/dashboard') },
      { path: 'dashboard', lazy: () => import('./routes/dashboard') },
      { path: 'admin', lazy: () => import('./routes/admin') },
      { path: 'cli', lazy: () => import('./routes/cli') },
      // Reserved slug (RESERVED_SLUGS) — MUST precede the `:space` catch-all so /whats-new resolves
      // to the release-notes archive, not a space lookup.
      { path: 'whats-new', lazy: () => import('./routes/whats-new') },
      // Reserved slugs, grouped with 'whats-new' for readability — but note their hazard is not
      // the one described above. Both are TWO-segment paths, so the one-segment `:space` could
      // never match them whatever the order, and the router ranks by specificity rather than
      // position anyway. What they genuinely compete with is the top-level `/:space/:site/*`
      // viewer: drop either entry and its URL renders as a site. router.test.ts asserts that by
      // resolution (matchRoutes), which is the only form of the check that means anything.
      { path: 'settings/keys', lazy: () => import('./routes/settings-keys') },
      { path: 'docs/api-keys', lazy: () => import('./routes/docs-api-keys') },
      { path: ':space', lazy: () => import('./routes/space') },
      { path: '*', lazy: () => import('./routes/not-found') },
    ],
  },
]
