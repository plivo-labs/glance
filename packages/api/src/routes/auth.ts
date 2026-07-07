import { decodeIdToken, generateCodeVerifier, generateState } from 'arctic'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { users } from '../db/schema'
import { bootstrapSuperadminByEmail, createPersonalSpace, superadminStatus, toSessionUser } from '../db/repo'
import { requireAuth } from '../middleware/auth'
import { bootstrapDecision } from '../lib/bootstrap'
import { createGoogle, isGoogleEnabled, OAUTH_SCOPES } from '../lib/oauth'
import { createCliToken, createSession, destroyCliToken, destroySession } from '../lib/session'
import type { AppEnv, Bindings, SessionUser } from '../types'

const OAUTH_COOKIE = 'glance_oauth'

/** Only allow same-origin absolute paths as a post-login redirect (no open redirect). */
function safeNext(next: string | null | undefined): string | null {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  return next
}

interface GoogleClaims {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  hd?: string
}

export const auth = new Hono<AppEnv>()

// --- Browser OAuth ---

auth.get('/google', async (c) => {
  if (!isGoogleEnabled(c.env)) return c.notFound()
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const next = safeNext(c.req.query('next')) // carried through the round-trip in the signed cookie
  const url = createGoogle(c.env).createAuthorizationURL(state, codeVerifier, OAUTH_SCOPES)
  url.searchParams.set('hd', c.env.ALLOWED_HD) // UX hint only; the hd claim is verified server-side

  await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify({ state, codeVerifier, next }), c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith('https://'),
    sameSite: 'Lax', // Strict would drop the cookie on the cross-site callback redirect
    path: '/',
    maxAge: 600,
  })
  return c.redirect(url.toString())
})

auth.get('/callback', async (c) => {
  if (!isGoogleEnabled(c.env)) return c.notFound()
  const code = c.req.query('code')
  const state = c.req.query('state')
  const stored = await getSignedCookie(c, c.env.SESSION_SECRET, OAUTH_COOKIE)
  deleteCookie(c, OAUTH_COOKIE, { path: '/' })

  if (!code || !state || typeof stored !== 'string') return c.redirect('/login?error=oauth')
  let parsed: { state: string; codeVerifier: string; next?: string | null }
  try {
    parsed = JSON.parse(stored)
  } catch {
    return c.redirect('/login?error=oauth')
  }
  if (parsed.state !== state) return c.redirect('/login?error=state')

  let claims: GoogleClaims
  try {
    const tokens = await createGoogle(c.env).validateAuthorizationCode(code, parsed.codeVerifier)
    claims = decodeIdToken(tokens.idToken()) as unknown as GoogleClaims
  } catch {
    return c.redirect('/login?error=exchange')
  }

  // Hard gate: trust the SIGNED hd claim, not the request param.
  const email = claims.email?.toLowerCase() ?? ''
  if (claims.hd !== c.env.ALLOWED_HD || !claims.email_verified || !email.endsWith(`@${c.env.ALLOWED_HD}`)) {
    return c.redirect('/login?error=denied')
  }

  const user = await findOrCreateUser(c.get('db'), c.env, claims, email)
  await createSession(c, user)
  return c.redirect(safeNext(parsed.next) ?? '/dashboard')
})

auth.post('/logout', async (c) => {
  await destroySession(c)
  // `glance logout` authenticates with a Bearer CLI token and no cookie, so also revoke that
  // token server-side — otherwise the logged-out CLI credential stays valid for its full 30d TTL.
  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ')) await destroyCliToken(c, header.slice(7))
  return c.json({ ok: true })
})

auth.get('/me', requireAuth, (c) => c.json(c.get('user')))

// DEV ONLY: skip Google OAuth for local browser testing. Hard-gated to a localhost
// APP_URL — in prod APP_URL is https://…workers.dev, so this 404s and can never run.
auth.post('/dev-login', async (c) => {
  if (!c.env.APP_URL.startsWith('http://localhost')) return c.notFound()
  const email = c.env.SUPERADMIN_EMAIL.toLowerCase()
  const user = await findOrCreateUser(
    c.get('db'),
    c.env,
    { sub: `dev-${email}`, email, email_verified: true, name: 'Dev User', hd: c.env.ALLOWED_HD },
    email,
  )
  await createSession(c, user)
  return c.json({ ok: true, user })
})

// --- First-run bootstrap (token-gated, no Google) ---
// Establishes the first superadmin on a fresh deploy. Inert (404) until BOOTSTRAP_TOKEN
// is set. The token rides in the POST body (never the URL — query strings leak via logs,
// history, and Referer). On first run there is no session cookie, so middleware
// `requireSameOrigin` is a no-op; this route does its OWN same-origin check.

// Persistent (no TTL) one-shot marker set AFTER the first bootstrap session is minted. While a
// configured superadmin exists but this is unset, the decision still allows a retry (anti-lockout);
// once set, bootstrap is 410 forever — so a still-set BOOTSTRAP_TOKEN is not a permanent credential.
const BOOTSTRAP_COMPLETE_KEY = 'bootstrap_complete'

auth.post('/bootstrap', async (c) => {
  const appOrigin = new URL(c.env.APP_URL).origin
  const sameOrigin = c.req.header('Origin') === appOrigin || c.req.header('Sec-Fetch-Site') === 'same-origin'
  if (!sameOrigin) return c.json({ error: 'csrf' }, 403)

  // One-shot lifetime op: a tighter window than the CLI default brakes token brute-force.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (await isCliStartRateLimited(c.env.GLANCE_SESSIONS, `bootstrap:${ip}`, 5, 3600))
    return c.json({ error: 'rate_limited' }, 429)

  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string })
  const db = c.get('db')
  const alreadyCompleted = (await c.env.GLANCE_SESSIONS.get(BOOTSTRAP_COMPLETE_KEY)) !== null
  const decision = await bootstrapDecision({
    expectedToken: c.env.BOOTSTRAP_TOKEN,
    providedToken: body.token,
    alreadyCompleted,
    status: () => superadminStatus(db, c.env.SUPERADMIN_EMAIL),
  })
  if (!decision.ok) return c.json({ error: 'bootstrap_unavailable' }, decision.status)

  // Session (KV) is confirmed before the run is marked "done"; the flag is set only AFTER a
  // successful mint, so a KV failure mid-way leaves it unset and the (anti-lockout) decision
  // lets a retry recover without re-locking the deploy. Once set, bootstrap is one-shot (410).
  const user = await bootstrapSuperadminByEmail(db, c.env.SUPERADMIN_EMAIL, null)
  await createSession(c, user)
  await c.env.GLANCE_SESSIONS.put(BOOTSTRAP_COMPLETE_KEY, '1')
  return c.json({ ok: true, user })
})

// --- CLI device-poll token flow ---
// CLI: POST /cli/start → open verificationUri in browser + poll /cli/poll.
// Browser (authed) confirms via POST /cli/approve → mints a 30-day CLI token.

// Crockford-ish base32: uppercase, no easily-confused chars (0/O/1/I excluded).
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USER_CODE_LENGTH = 8
const CLI_START_RL_LIMIT = 5 // starts per window
const CLI_START_RL_TTL = 60 // window seconds

/** Display/URL-safe uppercase device code with full CSPRNG entropy. */
export function generateUserCode(length = USER_CODE_LENGTH): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let code = ''
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  return code
}

/** Minimal KV surface the throttle needs — keeps the helper unit-testable. */
interface ThrottleKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/**
 * Best-effort per-IP throttle on the shared sessions KV. The read-modify-write is
 * NOT atomic, so concurrent starts can slip past the limit — that is acceptable for
 * a coarse abuse brake. Returns true when the caller is over the limit.
 */
export async function isCliStartRateLimited(
  kv: ThrottleKv,
  ip: string,
  limit = CLI_START_RL_LIMIT,
  ttl = CLI_START_RL_TTL,
): Promise<boolean> {
  const key = `cli_start_rl:${ip}`
  const count = Number(await kv.get(key)) || 0
  if (count >= limit) return true
  await kv.put(key, String(count + 1), { expirationTtl: ttl })
  return false
}

auth.post('/cli/start', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (await isCliStartRateLimited(c.env.GLANCE_SESSIONS, ip)) return c.json({ error: 'rate_limited' }, 429)

  const deviceCode = crypto.randomUUID()
  const userCode = generateUserCode()
  const record = JSON.stringify({ status: 'pending', userCode })
  await c.env.GLANCE_SESSIONS.put(`cli_device:${deviceCode}`, record, { expirationTtl: 600 })
  await c.env.GLANCE_SESSIONS.put(`cli_user:${userCode}`, deviceCode, { expirationTtl: 600 })
  return c.json({
    deviceCode,
    userCode,
    verificationUri: `${c.env.APP_URL}/cli?code=${userCode}`,
    interval: 2,
    expiresIn: 600,
  })
})

auth.get('/cli/poll', async (c) => {
  const deviceCode = c.req.query('device_code')
  if (!deviceCode) return c.json({ error: 'device_code required' }, 400)
  const raw = await c.env.GLANCE_SESSIONS.get(`cli_device:${deviceCode}`)
  if (!raw) return c.json({ status: 'expired' }, 404)
  const rec = JSON.parse(raw) as { status: string; token?: string }
  if (rec.status !== 'complete' || !rec.token) return c.json({ status: 'pending' })
  await c.env.GLANCE_SESSIONS.delete(`cli_device:${deviceCode}`) // one-time read
  return c.json({ status: 'complete', accessToken: rec.token })
})

auth.post('/cli/approve', requireAuth, async (c) => {
  const { userCode } = await c.req.json<{ userCode?: string }>()
  if (!userCode) return c.json({ error: 'userCode required' }, 400)
  const deviceCode = await c.env.GLANCE_SESSIONS.get(`cli_user:${userCode.toUpperCase()}`)
  if (!deviceCode) return c.json({ error: 'invalid or expired code' }, 404)
  const token = await createCliToken(c, c.get('user'))
  await c.env.GLANCE_SESSIONS.put(
    `cli_device:${deviceCode}`,
    JSON.stringify({ status: 'complete', token }),
    { expirationTtl: 600 },
  )
  await c.env.GLANCE_SESSIONS.delete(`cli_user:${userCode.toUpperCase()}`)
  return c.json({ ok: true })
})

// --- helpers ---

// Exported for characterization tests. Matches by googleId then email, so a Google login
// backfills onto a prior bootstrap user (googleId null, same email) without changing role.
export async function findOrCreateUser(
  db: AppEnv['Variables']['db'],
  env: Bindings,
  claims: GoogleClaims,
  email: string,
): Promise<SessionUser> {
  const byGoogle = await db.select().from(users).where(eq(users.googleId, claims.sub)).limit(1)
  const existing = byGoogle[0] ?? (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]

  if (existing) {
    const name = claims.name ?? existing.name
    await db.update(users).set({ name, googleId: claims.sub }).where(eq(users.id, existing.id))
    return toSessionUser({ ...existing, name })
  }

  const id = crypto.randomUUID()
  const role = email === env.SUPERADMIN_EMAIL.toLowerCase() ? 'superadmin' : 'member'
  await db.insert(users).values({ id, email, name: claims.name ?? null, googleId: claims.sub, role })
  await createPersonalSpace(db, id, email)
  return { id, email, name: claims.name ?? null, role }
}
