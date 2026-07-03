import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { readSessionOrBearer } from '../lib/session'
import type { AppEnv } from '../types'

const SESSION_COOKIE = 'glance_session'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * CSRF defense-in-depth. Only enforces on cookie-authenticated, state-changing requests:
 * if the `glance_session` cookie is present AND the method is unsafe, require same-origin
 * (Origin matches APP_URL, or Sec-Fetch-Site is 'same-origin') else 403. Bearer-token CLI
 * calls carry no cookie and pass through untouched; GET/HEAD always pass.
 */
export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const cookieAuthed = getCookie(c, SESSION_COOKIE) !== undefined
  if (cookieAuthed && UNSAFE_METHODS.has(c.req.method)) {
    const appOrigin = new URL(c.env.APP_URL).origin
    // Intentionally strict and fail-closed: ONLY an exact Origin match or Sec-Fetch-Site
    // 'same-origin' passes. 'same-site' is deliberately NOT accepted (it would open
    // subdomain-based CSRF); 'cross-site', 'none', and missing headers all fail both
    // checks → deny. Do not loosen this to 'same-site'.
    const sameOrigin = c.req.header('Origin') === appOrigin || c.req.header('Sec-Fetch-Site') === 'same-origin'
    if (!sameOrigin) return c.json({ error: 'csrf' }, 403)
  }
  await next()
})

/** 401 unless a valid browser session OR CLI Bearer token exists; attaches the user. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await readSessionOrBearer(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', user)
  // Tag the credential for usage analytics. The CLI sends a Bearer token and never a cookie;
  // browsers always carry the cookie. Session cookie wins (mirrors readSessionOrBearer), so a
  // request is 'cli' only when there's no cookie AND a Bearer token is present.
  const isBearer = c.req.header('Authorization')?.startsWith('Bearer ') ?? false
  const hasCookie = getCookie(c, SESSION_COOKIE) !== undefined
  c.set('authKind', !hasCookie && isBearer ? 'cli' : 'web')
  await next()
})

/** Must run after requireAuth. 403 unless the user is a superadmin. */
export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user')?.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)
  await next()
})
