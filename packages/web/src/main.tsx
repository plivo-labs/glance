import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createBrowserRouter,
  Link,
  type LoaderFunctionArgs,
  RouterProvider,
  redirect,
  useRouteError,
} from 'react-router'
import { AppShell } from './components/AppShell'
import { Button } from './components/ui/button'
import { Toaster } from './components/ui/sonner'
import { api, ApiError } from './lib/api'
import type { Me } from './lib/types'
import './tailwind.css'

// Root loader fetches identity ONCE before render (replaces a mount useEffect). It does
// NOT redirect — public site views must work logged-out; protected route loaders guard
// themselves.
async function rootLoader(): Promise<{ user: Me | null }> {
  try {
    return { user: await api.get<Me>('/api/auth/me') }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { user: null }
    throw err
  }
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

const router = createBrowserRouter([
  // Login is a standalone, full-bleed route (its own dark Blueprint hero) outside the shell.
  { path: '/login', lazy: () => import('./routes/login') },
  // Site preview is full-bleed too — a chrome-less, full-screen iframe (opened in a new tab).
  // Lives outside the shell so there's no header/nav; loader 401 → /login, 403/404/410 → RootError.
  // The trailing `*` carries an optional in-site file path (`/space/site/docs/page.html`) so a
  // deep link / the directory-listing fallback points the iframe at that file and the URL reflects it.
  { path: '/:space/:site/*', lazy: () => import('./routes/viewer'), ErrorBoundary: RootError },
  {
    path: '/',
    Component: AppShell,
    loader: rootLoader,
    ErrorBoundary: RootError,
    children: [
      { index: true, loader: () => redirect('/dashboard') },
      { path: 'dashboard', lazy: () => import('./routes/dashboard') },
      { path: 'admin', lazy: () => import('./routes/admin') },
      { path: 'cli', lazy: () => import('./routes/cli') },
      { path: ':space', lazy: () => import('./routes/space') },
      { path: '*', lazy: () => import('./routes/not-found') },
    ],
  },
])

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster richColors closeButton />
  </StrictMode>,
)
