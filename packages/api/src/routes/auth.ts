import { CodeChallengeMethod, decodeIdToken, generateCodeVerifier, generateState } from 'arctic'
import { and, eq, isNull, or } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { events, users } from '../db/schema'
import { bootstrapSuperadminByEmail, createPersonalSpace, superadminStatus, toSessionUser } from '../db/repo'
import { NEWEST_RELEASE_DATE } from '../whats-new/catalog'
import { requireAuth } from '../middleware/auth'
import { sanitizeAvatarUrl } from '../lib/avatar'
import { bootstrapDecision } from '../lib/bootstrap'
import { createGoogle, isGoogleEnabled, OAUTH_SCOPES } from '../lib/oauth'
import {
  acceptedOidcEmail,
  createOidc,
  discoverOidc,
  isOidcEnabled,
  type OidcClaims,
  type OidcEndpoints,
  oidcScopes,
  oidcSubjectKey,
  withUserinfo,
} from '../lib/oidc'
import {
  bearerToken,
  createCliToken,
  createSession,
  destroyCliToken,
  destroySession,
  readCredential,
} from '../lib/session'
import type { AppEnv, Bindings, SessionUser } from '../types'

// `__Host-` for the same reason as the session cookie (lib/session.ts): the content origin shares the
// app's registrable domain, and without the prefix it could plant its own signed state and finish a
// sign-in as the attacker (login CSRF).
const OAUTH_COOKIE = '__Host-glance_oauth'

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
  // Profile photo URL (granted by the `profile` scope). Stored host-pinned and served through
  // /api/avatars — never handed to the browser as-is. See lib/avatar.
  picture?: string
  hd?: string
}

export const auth = new Hono<AppEnv>()

// --- Browser OAuth ---

type OauthProvider = 'google' | 'oidc'

// The provider rides in the cookie too: without it a state minted by /api/auth/google could be
// replayed at /api/auth/oidc/callback (same state, same verifier, different token endpoint).
type OauthState = { provider: OauthProvider; state: string; codeVerifier: string; next?: string | null }

/** Starts an authorization-code round-trip: state, PKCE verifier and the post-login target ride in
 *  a short-lived signed cookie the callback reads back. */
async function beginOauth(
  c: Context<AppEnv>,
  provider: OauthProvider,
  build: (state: string, codeVerifier: string) => URL,
): Promise<Response> {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const next = safeNext(c.req.query('next')) // carried through the round-trip in the signed cookie
  const url = build(state, codeVerifier)
  const payload: OauthState = { provider, state, codeVerifier, next }
  await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify(payload), c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax', // Strict would drop the cookie on the cross-site callback redirect
    path: '/',
    maxAge: 600,
  })
  return c.redirect(url.toString())
}

/** The callback's code + stored round-trip state, or the /login error to send the browser to. */
async function finishOauth(
  c: Context<AppEnv>,
  provider: OauthProvider,
): Promise<{ code: string; stored: OauthState } | { error: string }> {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const stored = await getSignedCookie(c, c.env.SESSION_SECRET, OAUTH_COOKIE)
  deleteCookie(c, OAUTH_COOKIE, { path: '/', secure: true })

  if (!code || !state || typeof stored !== 'string') return { error: 'oauth' }
  let parsed: OauthState
  try {
    parsed = JSON.parse(stored)
  } catch {
    return { error: 'oauth' }
  }
  if (parsed.state !== state || parsed.provider !== provider) return { error: 'state' }
  return { code, stored: parsed }
}

auth.get('/google', async (c) => {
  if (!isGoogleEnabled(c.env)) return c.notFound()
  return beginOauth(c, 'google', (state, codeVerifier) => {
    const url = createGoogle(c.env).createAuthorizationURL(state, codeVerifier, OAUTH_SCOPES)
    url.searchParams.set('hd', c.env.ALLOWED_HD) // UX hint only; the hd claim is verified server-side
    return url
  })
})

auth.get('/callback', async (c) => {
  if (!isGoogleEnabled(c.env)) return c.notFound()
  const round = await finishOauth(c, 'google')
  if ('error' in round) return c.redirect(`/login?error=${round.error}`)

  let claims: GoogleClaims
  try {
    const tokens = await createGoogle(c.env).validateAuthorizationCode(round.code, round.stored.codeVerifier)
    claims = decodeIdToken(tokens.idToken()) as unknown as GoogleClaims
  } catch {
    return c.redirect('/login?error=exchange')
  }

  // Hard gate: trust the SIGNED hd claim, not the request param.
  const email = claims.email?.toLowerCase() ?? ''
  if (claims.hd !== c.env.ALLOWED_HD || !claims.email_verified || !email.endsWith(`@${c.env.ALLOWED_HD}`)) {
    return c.redirect('/login?error=denied')
  }

  const db = c.get('db')
  const user = await signingIn(c, () => findOrCreateIdentity(db, c.env, 'google', claims, email))
  if (user instanceof Response) return user
  await createSession(c, user)
  return c.redirect(safeNext(round.stored.next) ?? '/dashboard')
})

auth.get('/oidc', async (c) => {
  if (!isOidcEnabled(c.env)) return c.notFound()
  let endpoints: OidcEndpoints
  try {
    endpoints = await discoverOidc(c.env)
  } catch (err) {
    console.error('oidc: discovery failed', err)
    return c.redirect('/login?error=oauth')
  }
  return beginOauth(c, 'oidc', (state, codeVerifier) =>
    createOidc(c.env).createAuthorizationURLWithPKCE(
      endpoints.authorization_endpoint,
      state,
      CodeChallengeMethod.S256,
      codeVerifier,
      oidcScopes(c.env),
    ),
  )
})

auth.get('/oidc/callback', async (c) => {
  if (!isOidcEnabled(c.env)) return c.notFound()
  const round = await finishOauth(c, 'oidc')
  if ('error' in round) return c.redirect(`/login?error=${round.error}`)

  let claims: OidcClaims
  try {
    const endpoints = await discoverOidc(c.env)
    const tokens = await createOidc(c.env).validateAuthorizationCode(
      endpoints.token_endpoint,
      round.code,
      round.stored.codeVerifier,
    )
    claims = await withUserinfo(decodeIdToken(tokens.idToken()) as OidcClaims, endpoints, tokens.accessToken())
  } catch (err) {
    console.error('oidc: token exchange failed', err)
    return c.redirect('/login?error=exchange')
  }

  const accepted = acceptedOidcEmail(claims, c.env)
  if ('refused' in accepted) {
    console.warn(`oidc: id_token refused (${accepted.refused})`)
    return c.redirect('/login?error=denied')
  }
  const email = accepted.email

  const db = c.get('db')
  const user = await signingIn(c, () => findOrCreateIdentity(db, c.env, 'oidc', claims, email))
  if (user instanceof Response) return user
  await createSession(c, user)
  return c.redirect(safeNext(round.stored.next) ?? '/dashboard')
})

auth.post('/logout', async (c) => {
  // This route runs neither requireAuth nor requireSameOrigin's cookie gate, so the credential is
  // resolved directly. A `glk_` API key is not a session — `glance logout` is the wrong verb for
  // it (a key is revoked from the keys screen, not by logging out) — so report that rather than
  // silently doing nothing: destroyCliToken below is a KV delete and no-ops on a D1 key, and a
  // false { ok: true } would tell the caller a credential was revoked when it was not.
  if ((await readCredential(c))?.kind === 'key') {
    return c.json({ error: 'not_a_session', message: 'This is an API key — revoke it from the keys screen, not logout.' }, 400)
  }

  await destroySession(c)
  // `glance logout` authenticates with a Bearer CLI token and no cookie, so also revoke that
  // token server-side — otherwise the logged-out CLI credential stays valid for its full 30d TTL.
  const token = bearerToken(c)
  if (token) await destroyCliToken(c, token)
  return c.json({ ok: true })
})

// `hasUsedCli` rides along so the dashboard can hide the CLI-install banner for anyone whose CLI
// has already made an authenticated call (an events row exists — see middleware/analytics.ts).
// limit(1) is the EXISTS check; the events_user_created index serves it.
auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user')
  const used = await c
    .get('db')
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.type, 'cli'), eq(events.userId, user.id)))
    .limit(1)
  return c.json({ ...user, hasUsedCli: used.length > 0 })
})

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
  const user = await bootstrapSuperadminByEmail(db, c.env.SUPERADMIN_EMAIL, null, NEWEST_RELEASE_DATE)
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

// Exported for characterization tests. Matches by googleId then email, so a Google login backfills
// onto a prior bootstrap user (googleId null, same email) without changing role. An email that
// already carries a DIFFERENT googleId is refused, never re-pointed.
export function findOrCreateUser(
  db: AppEnv['Variables']['db'],
  env: Bindings,
  claims: GoogleClaims,
  email: string,
): Promise<SessionUser> {
  return findOrCreateIdentity(db, env, 'google', claims, email)
}

/** A sign-in the identity rules refuse. `link` = this verified email already belongs to another
 *  identity; `sso` = the account's access is managed by a provider that must sign it in. */
export class SignInRefused extends Error {
  constructor(readonly reason: 'link' | 'sso') {
    super(`sign-in refused: ${reason}`)
  }
}

/** Runs a find-or-create, turning a policy refusal into the /login redirect that explains it. */
async function signingIn(c: Context<AppEnv>, create: () => Promise<SessionUser>): Promise<SessionUser | Response> {
  try {
    return await create()
  } catch (err) {
    if (err instanceof SignInRefused) return c.redirect(`/login?error=${err.reason}`)
    throw err
  }
}

/** Signs in the user whose stored subject is `claims.sub`, else the account with this (verified)
 *  email — adopting it only under the rules below — else a new member with a personal space.
 *  Never promotes. Throws SignInRefused when the email is not this identity's to take. */
async function findOrCreateIdentity(
  db: AppEnv['Variables']['db'],
  env: Bindings,
  provider: OauthProvider,
  claims: { sub: string; name?: string; picture?: string },
  email: string,
): Promise<SessionUser> {
  const subject = provider === 'oidc' ? oidcSubjectKey(env.OIDC_ISSUER as string, claims.sub) : claims.sub
  const stored = provider === 'oidc' ? { oidcSub: subject } : { googleId: subject }
  const subjectColumn = provider === 'oidc' ? users.oidcSub : users.googleId
  const bySubject = await db.select().from(users).where(eq(subjectColumn, subject)).limit(1)
  let existing = bySubject[0]
  if (!existing) {
    existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
    if (existing) assertAdoptable(provider, env, existing)
  }

  // The photo is re-read from the id_token on EVERY login, which is also the only backfill Google
  // offers: users who signed up before avatars existed get one the next time they sign in. A claim
  // that fails the host pin leaves the stored URL untouched rather than clearing a good one.
  const avatarUrl = sanitizeAvatarUrl(claims.picture)

  if (existing) {
    const name = claims.name ?? existing.name
    // The subject condition makes adoption atomic: of two sign-ins that both found this row
    // subjectless, only the first write matches, and the other is refused instead of overwriting it.
    const updated = await db
      .update(users)
      .set({ name, ...stored, avatarUrl: avatarUrl ?? existing.avatarUrl })
      .where(and(eq(users.id, existing.id), or(isNull(subjectColumn), eq(subjectColumn, subject))))
      .returning({ id: users.id })
    if (updated.length === 0) throw new SignInRefused('link')
    return toSessionUser({ ...existing, name })
  }

  const id = crypto.randomUUID()
  const role = email === env.SUPERADMIN_EMAIL.toLowerCase() ? 'superadmin' : 'member'
  // New signups start caught up on release notes (watermark = newest), so they don't land on an
  // inbox full of "unread" features that shipped before they existed. null would mean all-unread.
  await db.insert(users).values({
    id,
    email,
    name: claims.name ?? null,
    ...stored,
    avatarUrl,
    role,
    lastSeenReleaseAt: NEWEST_RELEASE_DATE,
  })
  await createPersonalSpace(db, id, email)
  return { id, email, name: claims.name ?? null, role }
}

/** The rules for adopting an existing row by its (provider-verified) email, i.e. linking a second
 *  identity onto it. The row never gets a subject overwritten: doing that would hand whatever the
 *  row owns to a recycled, renamed or attacker-controlled email at the provider. */
function assertAdoptable(
  provider: OauthProvider,
  env: Bindings,
  existing: { googleId: string | null; oidcSub: string | null; role: SessionUser['role'] },
): void {
  if (provider === 'google') {
    // bySubject already missed, so a non-null googleId here is a DIFFERENT Google identity.
    if (existing.googleId !== null) throw new SignInRefused('link')
    return
  }

  if (existing.oidcSub !== null) throw new SignInRefused('link')
  // An account that already belongs to Google, or that is a superadmin, is only adoptable when the
  // deploy says so: the IdP cannot prove it controls the same address the way Google's `hd` does.
  const needsOptIn = existing.googleId !== null || existing.role === 'superadmin'
  if (needsOptIn && env.OIDC_LINK_EXISTING !== '1') throw new SignInRefused('link')
}
