import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { getUserById } from '../db/repo'
import { bearerToken, readCredential } from '../lib/session'
import type { AppEnv } from '../types'

const SESSION_COOKIE = '__Host-glance_session'
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

/** 401 unless a valid browser session, CLI Bearer token, or D1 API key exists; attaches the LIVE
 *  user plus the resolved Credential (which store authenticated the request). */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const credential = await readCredential(c)
  if (!credential) return c.json({ error: 'unauthorized' }, 401)
  // The KV session / D1 key lookup is a snapshot frozen for the token's life (24h cookie / 30d
  // CLI / until the key is queried again). Re-resolve the live row each request so a deleted
  // user is rejected (401) and a role/email change takes effect immediately — e.g. a demoted
  // superadmin loses privilege now (requireSuperAdmin sees the fresh role) rather than at token
  // expiry. Single indexed PK read; the viewer hot path reads readSessionOrBearer inline (not
  // this middleware), so FCP is unaffected.
  const user = await getUserById(c.get('db'), credential.user.id)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', user)
  c.set('credential', credential)
  // Tag the credential for usage analytics. The CLI sends a Bearer token and never a cookie;
  // browsers always carry the cookie. Session cookie wins (mirrors readSessionOrBearer), so a
  // request is 'cli' only when there's no cookie AND a Bearer token is present.
  const hasCookie = getCookie(c, SESSION_COOKIE) !== undefined
  c.set('authKind', !hasCookie && bearerToken(c) !== null ? 'cli' : 'web')
  await next()
})

// Methods that CHANGE control-plane state. A key without the control grant may still read
// (listing sites, resolving a site before minting a data token); what it may not do is deploy,
// create, fork, move or otherwise mutate. GET/HEAD are exactly the operations the data-only key
// in the wireframe still needs.
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Must run after requireAuth. 403s a key credential that was minted WITHOUT the control grant
 * when it tries to change control-plane state.
 *
 * This exists because `grants.control` is a promise made to the user at mint time — the dialog
 * offers it as an opt-in and the docs say it is what lets a key deploy. Storing that flag and
 * never reading it is worse than not offering it: the operator believes they minted a data-only
 * key and actually minted one with the full control plane. Session and CLI credentials are
 * unaffected — they carry no grants and are governed by ownership alone, exactly as before.
 */
export const requireControlGrant = createMiddleware<AppEnv>(async (c, next) => {
  const credential = c.get('credential')
  if (credential?.kind === 'key' && !credential.grants.control && UNSAFE.has(c.req.method)) {
    return c.json({ error: 'forbidden' }, 403)
  }
  await next()
})

/** Must run after requireAuth. 403 unless the user is a superadmin. */
export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user')?.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)
  await next()
})
