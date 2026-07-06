import type { Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { AppEnv, SessionUser } from '../types'

const SESSION_COOKIE = 'glance_session'
const SESSION_TTL = 60 * 60 * 24 // 24h
const CLI_TTL = 60 * 60 * 24 * 30 // 30d

// SameSite=Lax (not Strict): the post-OAuth redirect and shared inbound links are
// top-level GET navigations; Strict would drop the cookie and force a re-login.
function cookieOpts(c: Context<AppEnv>) {
  return { httpOnly: true, secure: c.env.APP_URL.startsWith('https://'), sameSite: 'Lax' as const, path: '/' }
}

export async function createSession(c: Context<AppEnv>, user: SessionUser): Promise<void> {
  const token = crypto.randomUUID()
  await c.env.GLANCE_SESSIONS.put(`session:${token}`, JSON.stringify(user), { expirationTtl: SESSION_TTL })
  await setSignedCookie(c, SESSION_COOKIE, token, c.env.SESSION_SECRET, { ...cookieOpts(c), maxAge: SESSION_TTL })
}

export async function readSession(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE)
  if (typeof token !== 'string') return null // false = tampered, undefined = missing
  const raw = await c.env.GLANCE_SESSIONS.get(`session:${token}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionUser
  } catch {
    return null
  }
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE)
  if (typeof token === 'string') await c.env.GLANCE_SESSIONS.delete(`session:${token}`)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

// --- CLI tokens (opaque, long-lived, stored in KV; sent as Bearer by the CLI) ---

export async function createCliToken(c: Context<AppEnv>, user: SessionUser): Promise<string> {
  const token = crypto.randomUUID()
  await c.env.GLANCE_SESSIONS.put(`cli:${token}`, JSON.stringify(user), { expirationTtl: CLI_TTL })
  // Per-user index entry (same TTL) so every token a user holds is enumerable — the revocation
  // surface `revokeUserCliTokens` lists this prefix. Keyed by token so it can be deleted directly.
  await c.env.GLANCE_SESSIONS.put(`cli_index:${user.id}:${token}`, '', { expirationTtl: CLI_TTL })
  return token
}

/** Delete a single CLI token and its per-user index entry. `glance logout` sends a Bearer
 *  token and no cookie, so the logout handler calls this to actually revoke the credential
 *  server-side (otherwise it stayed valid for its full 30-day TTL). */
export async function destroyCliToken(c: Context<AppEnv>, token: string): Promise<void> {
  const raw = await c.env.GLANCE_SESSIONS.get(`cli:${token}`)
  await c.env.GLANCE_SESSIONS.delete(`cli:${token}`)
  if (!raw) return
  try {
    const { id } = JSON.parse(raw) as SessionUser
    await c.env.GLANCE_SESSIONS.delete(`cli_index:${id}:${token}`)
  } catch {
    // Unparseable record: the token itself is gone; the orphaned index entry ages out on its TTL.
  }
}

/** Revoke EVERY CLI token a user holds — the offboarding kill-switch. Enumerates the per-user
 *  index (`cli_index:<userId>:*`) and deletes each `cli:<token>` plus its index entry. */
export async function revokeUserCliTokens(c: Context<AppEnv>, userId: string): Promise<void> {
  const prefix = `cli_index:${userId}:`
  let cursor: string | undefined
  do {
    const page = await c.env.GLANCE_SESSIONS.list({ prefix, cursor })
    for (const { name } of page.keys) {
      const token = name.slice(prefix.length)
      await c.env.GLANCE_SESSIONS.delete(`cli:${token}`)
      await c.env.GLANCE_SESSIONS.delete(name)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

export async function readCliToken(c: Context<AppEnv>, token: string): Promise<SessionUser | null> {
  const raw = await c.env.GLANCE_SESSIONS.get(`cli:${token}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionUser
  } catch {
    return null
  }
}

// Resolve the request's user from the session cookie, falling back to a CLI Bearer token.
// Used by `requireAuth` and by route handlers that read the user inline (rather than via the
// middleware) so they can shape their own not-found / forbidden JSON — e.g. the viewer endpoint.
export async function readSessionOrBearer(c: Context<AppEnv>): Promise<SessionUser | null> {
  const user = await readSession(c)
  if (user) return user
  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ')) return readCliToken(c, header.slice(7))
  return null
}
