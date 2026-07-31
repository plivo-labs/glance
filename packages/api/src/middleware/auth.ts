import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { getUserById } from '../db/repo'
import { readSessionOrBearer } from '../lib/session'
import type { AppEnv } from '../types'

const SESSION_COOKIE = '__Host-glance_session'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** True when the request's cookie jar carries a session cookie AT ALL — presence, not validity,
 *  is the signal: a stale/tampered cookie still proves "this came from a browser that has this
 *  app's origin in its jar" which is exactly the context CSWSH/CSRF need to worry about. */
export const cookieAuthed = (c: Context<AppEnv>): boolean => getCookie(c, SESSION_COOKIE) !== undefined

/** Origin matches APP_URL, or Sec-Fetch-Site is 'same-origin' — the one predicate every
 *  same-origin gate in this file shares. Intentionally strict and fail-closed: 'same-site' is
 *  deliberately NOT accepted (it would open subdomain-based CSRF/CSWSH — the sandboxed content
 *  origin shares this app's registrable domain and must never pass); 'cross-site', 'none', and
 *  missing headers all fail both checks → deny. Do not loosen this to 'same-site'. */
export const isSameOrigin = (c: Context<AppEnv>): boolean => {
  const appOrigin = new URL(c.env.APP_URL).origin
  return c.req.header('Origin') === appOrigin || c.req.header('Sec-Fetch-Site') === 'same-origin'
}

/**
 * CSRF defense-in-depth. Only enforces on cookie-authenticated, state-changing requests:
 * if the `glance_session` cookie is present AND the method is unsafe, require same-origin
 * else 403. Bearer-token CLI calls carry no cookie and pass through untouched; GET/HEAD
 * always pass — safe because a foreign origin's fetch/XHR still can't READ the JSON body
 * without this app's CORS allowing it (unlike a WebSocket upgrade, which is CORS-exempt;
 * see comments.ts's own same-origin guard on its socket route for that case).
 */
export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (cookieAuthed(c) && UNSAFE_METHODS.has(c.req.method) && !isSameOrigin(c)) {
    return c.json({ error: 'csrf' }, 403)
  }
  await next()
})

/** 401 unless a valid browser session OR CLI Bearer token exists; attaches the LIVE user. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSessionOrBearer(c)
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  // The KV session is a snapshot frozen for the token's life (24h cookie / 30d CLI). Re-resolve
  // the live row each request so a deleted user is rejected (401) and a role/email change takes
  // effect immediately — e.g. a demoted superadmin loses privilege now (requireSuperAdmin sees
  // the fresh role) rather than at token expiry. Single indexed PK read; the viewer hot path
  // reads readSessionOrBearer inline (not this middleware), so FCP is unaffected.
  const user = await getUserById(c.get('db'), session.id)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', user)
  // Tag the credential for usage analytics. The CLI sends a Bearer token and never a cookie;
  // browsers always carry the cookie. Session cookie wins (mirrors readSessionOrBearer), so a
  // request is 'cli' only when there's no cookie AND a Bearer token is present.
  const isBearer = c.req.header('Authorization')?.startsWith('Bearer ') ?? false
  c.set('authKind', !cookieAuthed(c) && isBearer ? 'cli' : 'web')
  await next()
})

/** Must run after requireAuth. 403 unless the user is a superadmin. */
export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user')?.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)
  await next()
})
