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
  return token
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
