import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { spaces, users } from '../db/schema'
import { resetOidcDiscovery } from '../lib/oidc'
import { makeDb, makeKv } from '../test/harness'
import type { AppEnv } from '../types'
import { auth } from './auth'

const APP_URL = 'https://glance.example.com'
const ISSUER = 'https://idp.example.com'
const AUTHORIZE = `${ISSUER}/oauth2/v1/authorize`
const TOKEN = `${ISSUER}/oauth2/v1/token`
const USERINFO = `${ISSUER}/oauth2/v1/userinfo`

const realFetch = globalThis.fetch
let tokenRequests: URLSearchParams[] = []
let idTokenClaims: Record<string, unknown> = {}
let discoveryIssuer = ISSUER
let userinfo: Record<string, unknown> | null = null

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`

beforeEach(() => {
  resetOidcDiscovery()
  tokenRequests = []
  discoveryIssuer = ISSUER
  userinfo = null
  idTokenClaims = claims()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    if (req.url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: discoveryIssuer,
        authorization_endpoint: AUTHORIZE,
        token_endpoint: TOKEN,
        ...(userinfo && { userinfo_endpoint: USERINFO }),
      })
    }
    if (req.url === TOKEN) {
      tokenRequests.push(new URLSearchParams(await req.text()))
      return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken(idTokenClaims) })
    }
    if (req.url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken(idTokenClaims) })
    }
    if (req.url === USERINFO && req.headers.get('authorization') === 'Bearer at' && userinfo) {
      return Response.json(userinfo)
    }
    return new Response('unexpected fetch', { status: 500 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: 'glance-client',
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: 'idp-john',
    email: 'John.Doe@example.com',
    email_verified: true,
    name: 'John Doe',
    ...overrides,
  }
}

function setup(overrides: Partial<AppEnv['Bindings']> = {}) {
  const db = makeDb()
  const kv = makeKv()
  const env = {
    APP_URL,
    SESSION_SECRET: 'sess-secret',
    ALLOWED_HD: 'example.com',
    SUPERADMIN_EMAIL: 'owner@example.com',
    GLANCE_SESSIONS: kv,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'glance-client',
    OIDC_CLIENT_SECRET: 'glance-secret',
    ...overrides,
  } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/auth', auth)
  return { app, env, db, kv }
}

/** Runs the browser half of the round-trip: start, then follow the provider back to the callback. */
async function signIn(app: Hono<AppEnv>, env: AppEnv['Bindings'], next = '') {
  const start = await app.request(`/api/auth/oidc${next ? `?next=${encodeURIComponent(next)}` : ''}`, {}, env)
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]
  return app.request(`/api/auth/oidc/callback?code=the-code&state=${state}`, { headers: { cookie } }, env)
}

/** The same round-trip through the Google routes (the token endpoint is mocked above). */
async function googleSignIn(app: Hono<AppEnv>, env: AppEnv['Bindings']) {
  const start = await app.request('/api/auth/google', {}, env)
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]
  return app.request(`/api/auth/callback?code=the-code&state=${state}`, { headers: { cookie } }, env)
}

const GOOGLE_ENV = { GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }

describe('OIDC sign-in routes', () => {
  test('inert without issuer, client id and secret → 404 on both routes', async () => {
    const { app, env } = setup({ OIDC_CLIENT_SECRET: undefined })
    expect((await app.request('/api/auth/oidc', {}, env)).status).toBe(404)
    expect((await app.request('/api/auth/oidc/callback?code=x&state=y', {}, env)).status).toBe(404)
  })

  test('start redirects to the discovered authorize endpoint with PKCE S256, scopes and redirect URI', async () => {
    const { app, env } = setup({ OIDC_SCOPES: 'openid email groups' })
    const res = await app.request('/api/auth/oidc', {}, env)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location') ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE)
    expect(url.searchParams.get('client_id')).toBe('glance-client')
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/auth/oidc/callback`)
    expect(url.searchParams.get('scope')).toBe('openid email groups')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    // __Host- keeps a sibling subdomain (the content origin) from planting its own state cookie.
    expect(res.headers.get('set-cookie') ?? '').toMatch(/^__Host-glance_oauth=.*; Secure/)
  })

  test('a discovery document for another issuer is refused → /login?error=oauth', async () => {
    discoveryIssuer = 'https://evil.example.com'
    const { app, env } = setup()
    const res = await app.request('/api/auth/oidc', {}, env)
    expect(res.headers.get('location')).toBe('/login?error=oauth')
  })

  test('callback exchanges the code with the verifier, creates the user and a session, honors next', async () => {
    const { app, env, db } = setup()
    const res = await signIn(app, env, '/s/team/report')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/s/team/report')
    expect(res.headers.get('set-cookie') ?? '').toContain('__Host-glance_session=')
    expect(tokenRequests[0]?.get('code')).toBe('the-code')
    expect(tokenRequests[0]?.get('code_verifier')).toBeTruthy()

    const row = (await db.select().from(users).where(eq(users.oidcSub, `${ISSUER} idp-john`)))[0]
    expect(row).toMatchObject({ email: 'john.doe@example.com', name: 'John Doe', role: 'member', googleId: null })
    const personal = await db.select().from(spaces).where(eq(spaces.createdBy, row.id))
    expect(personal.map((s) => s.type)).toEqual(['personal'])
  })

  test('a later sign-in by email links the subject onto a subjectless (e.g. bootstrap) user', async () => {
    const { app, env, db } = setup()
    await db.insert(users).values({ id: 'boot', email: 'john.doe@example.com', role: 'member' })

    await signIn(app, env)

    const rows = await db.select().from(users)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'boot', oidcSub: `${ISSUER} idp-john`, role: 'member' })
  })

  test('a superadmin account is only adopted by email with OIDC_LINK_EXISTING', async () => {
    const refused = setup()
    await refused.db.insert(users).values({ id: 'boot', email: 'john.doe@example.com', role: 'superadmin' })
    expect((await signIn(refused.app, refused.env)).headers.get('location')).toBe('/login?error=link')
    expect((await refused.db.select().from(users))[0]?.oidcSub).toBeNull()

    const allowed = setup({ OIDC_LINK_EXISTING: '1' })
    await allowed.db.insert(users).values({ id: 'boot', email: 'john.doe@example.com', role: 'superadmin' })
    await signIn(allowed.app, allowed.env)
    expect((await allowed.db.select().from(users))[0]).toMatchObject({ id: 'boot', role: 'superadmin' })
    expect((await allowed.db.select().from(users))[0]?.oidcSub).toBe(`${ISSUER} idp-john`)
  })

  test('a stored OIDC subject is never overwritten by another subject on the same email', async () => {
    const { app, env, db } = setup()
    await db.insert(users).values({ id: 'old', email: 'john.doe@example.com', oidcSub: `${ISSUER} recycled` })

    const res = await signIn(app, env)

    expect(res.headers.get('location')).toBe('/login?error=link')
    expect((await db.select().from(users))[0]?.oidcSub).toBe(`${ISSUER} recycled`)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('__Host-glance_session=')
  })

  test('of two sign-ins adopting the same subjectless row, the one that writes second is refused', async () => {
    const { app, env, db } = setup()
    await db.insert(users).values({ id: 'boot', email: 'john.doe@example.com', role: 'member' })
    // The competing sign-in lands between this one's adoptability check and its write.
    const update = db.update.bind(db)
    db.update = ((table: typeof users) => {
      db.update = update
      update(users).set({ oidcSub: `${ISSUER} idp-eve` }).where(eq(users.id, 'boot')).run() // sync on bun:sqlite
      return update(table)
    }) as typeof db.update

    const res = await signIn(app, env)

    expect(res.headers.get('location')).toBe('/login?error=link')
    expect((await db.select().from(users))[0]?.oidcSub).toBe(`${ISSUER} idp-eve`)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('__Host-glance_session=')
  })

  test('an email that belongs to a Google account is only adopted with OIDC_LINK_EXISTING', async () => {
    const refused = setup()
    await refused.db.insert(users).values({ id: 'g', email: 'john.doe@example.com', googleId: 'g-1' })
    expect((await signIn(refused.app, refused.env)).headers.get('location')).toBe('/login?error=link')

    const allowed = setup({ OIDC_LINK_EXISTING: '1' })
    await allowed.db.insert(users).values({ id: 'g', email: 'john.doe@example.com', googleId: 'g-1' })
    await signIn(allowed.app, allowed.env)
    expect((await allowed.db.select().from(users))[0]).toMatchObject({ id: 'g', googleId: 'g-1' })
    expect((await allowed.db.select().from(users))[0]?.oidcSub).toBe(`${ISSUER} idp-john`)
  })

  for (const [label, override] of [
    ['an unverified email', { email_verified: false }],
    ['an email outside ALLOWED_HD', { email: 'john@other.com' }],
    ['another audience', { aud: 'some-other-client' }],
    ['another issuer', { iss: 'https://evil.example.com' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ] as const) {
    test(`an id_token with ${label} is denied and creates nobody`, async () => {
      const { app, env, db } = setup()
      idTokenClaims = claims(override)
      const res = await signIn(app, env)
      expect(res.headers.get('location')).toBe('/login?error=denied')
      expect(await db.select().from(users)).toHaveLength(0)
    })
  }

  test('a thin id_token (Okta org server) is completed from userinfo', async () => {
    const { app, env, db } = setup()
    const { email: _email, email_verified: _verified, ...thin } = claims()
    idTokenClaims = thin
    userinfo = { sub: 'idp-john', email: 'john.doe@example.com', email_verified: true }

    const res = await signIn(app, env)

    expect(res.headers.get('location')).toBe('/dashboard')
    expect((await db.select().from(users))[0]).toMatchObject({
      email: 'john.doe@example.com',
      oidcSub: `${ISSUER} idp-john`,
    })
  })

  test("the id_token's email_verified never vouches for the email userinfo supplies", async () => {
    const { app, env, db } = setup()
    const { email: _email, ...noEmail } = claims()
    idTokenClaims = noEmail
    userinfo = { sub: 'idp-john', email: 'john.doe@example.com', email_verified: false }

    const res = await signIn(app, env)

    expect(res.headers.get('location')).toBe('/login?error=denied')
    expect(await db.select().from(users)).toHaveLength(0)
  })

  test('a userinfo response for another subject is refused', async () => {
    const { app, env, db } = setup()
    userinfo = { sub: 'someone-else', email: 'eve@example.com', email_verified: true }
    const res = await signIn(app, env)
    expect(res.headers.get('location')).toBe('/login?error=exchange')
    expect(await db.select().from(users)).toHaveLength(0)
  })

  test('a callback whose state does not match the cookie is refused before any exchange', async () => {
    const { app, env } = setup()
    const start = await app.request('/api/auth/oidc', {}, env)
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]
    const res = await app.request('/api/auth/oidc/callback?code=c&state=forged', { headers: { cookie } }, env)
    expect(res.headers.get('location')).toBe('/login?error=state')
    expect(tokenRequests).toHaveLength(0)
  })

  test('an id_token without a subject is denied', async () => {
    const { app, env, db } = setup()
    idTokenClaims = claims({ sub: '' })
    expect((await signIn(app, env)).headers.get('location')).toBe('/login?error=denied')
    expect(await db.select().from(users)).toHaveLength(0)
  })

  test('several audiences need azp naming this client', async () => {
    const { app, env } = setup()
    idTokenClaims = claims({ aud: ['glance-client', 'another-client'] })
    expect((await signIn(app, env)).headers.get('location')).toBe('/login?error=denied')

    idTokenClaims = claims({ aud: ['glance-client', 'another-client'], azp: 'another-client' })
    expect((await signIn(app, env)).headers.get('location')).toBe('/login?error=denied')

    idTokenClaims = claims({ aud: ['glance-client', 'another-client'], azp: 'glance-client' })
    expect((await signIn(app, env)).headers.get('location')).toBe('/dashboard')
  })

  test('a non-https issuer or endpoint is refused before any redirect', async () => {
    const plain = setup({ OIDC_ISSUER: 'http://idp.example.com' })
    expect((await plain.app.request('/api/auth/oidc', {}, plain.env)).headers.get('location')).toBe('/login?error=oauth')

    const { app, env } = setup()
    globalThis.fetch = (async () =>
      Response.json({
        issuer: ISSUER,
        authorization_endpoint: 'http://idp.example.com/authorize',
        token_endpoint: TOKEN,
      })) as unknown as typeof fetch
    expect((await app.request('/api/auth/oidc', {}, env)).headers.get('location')).toBe('/login?error=oauth')
  })

  test('a state cookie minted for Google cannot finish the OIDC callback', async () => {
    const { app, env } = setup({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' })
    const start = await app.request('/api/auth/google', {}, env)
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]

    const res = await app.request(`/api/auth/oidc/callback?code=c&state=${state}`, { headers: { cookie } }, env)
    expect(res.headers.get('location')).toBe('/login?error=state')
    expect(tokenRequests).toHaveLength(0)
  })

  test('the admin group sets the role, a missing claim leaves it, an empty list demotes', async () => {
    const { app, env, db } = setup({ OIDC_ADMIN_GROUP: 'app.glance.admins' })

    idTokenClaims = claims({ groups: ['app.glance.admins'] })
    await signIn(app, env)
    expect((await db.select().from(users))[0]?.role).toBe('superadmin')

    // No groups claim at all is "unknown" (lib/oidc.ts oidcGroups), not "no groups".
    idTokenClaims = claims()
    await signIn(app, env)
    expect((await db.select().from(users))[0]?.role).toBe('superadmin')

    // Entra's group overage names the claim in _claim_names: whatever list is left is incomplete.
    idTokenClaims = claims({ groups: [], _claim_names: { groups: 'src1' } })
    await signIn(app, env)
    expect((await db.select().from(users))[0]?.role).toBe('superadmin')

    idTokenClaims = claims({ groups: [] })
    await signIn(app, env)
    expect((await db.select().from(users))[0]?.role).toBe('member')
  })

  test('a Google sign-in is refused for an OIDC account while the admin sync is on', async () => {
    const { app, env, db } = setup({ ...GOOGLE_ENV, OIDC_ADMIN_GROUP: 'app.glance.admins' })
    await db.insert(users).values({ id: 'u', email: 'john.doe@example.com', oidcSub: `${ISSUER} idp-john` })
    idTokenClaims = { sub: 'g-1', email: 'john.doe@example.com', email_verified: true, hd: 'example.com' }

    const res = await googleSignIn(app, env)
    expect(res.headers.get('location')).toBe('/login?error=sso')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('__Host-glance_session=')
  })

  test('a Google sign-in never re-points an email that belongs to another Google identity', async () => {
    const { app, env, db } = setup(GOOGLE_ENV)
    await db.insert(users).values({ id: 'g', email: 'john.doe@example.com', googleId: 'g-other' })
    idTokenClaims = { sub: 'g-1', email: 'john.doe@example.com', email_verified: true, hd: 'example.com' }

    const res = await googleSignIn(app, env)
    expect(res.headers.get('location')).toBe('/login?error=link')
    expect((await db.select().from(users))[0]?.googleId).toBe('g-other')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('__Host-glance_session=')
  })

  test('the Google guard checks the account the googleId resolves to, not the email', async () => {
    const { app, env, db } = setup({ ...GOOGLE_ENV, OIDC_ADMIN_GROUP: 'app.glance.admins' })
    await db
      .insert(users)
      .values({ id: 'u', email: 'john.doe@example.com', googleId: 'g-1', oidcSub: `${ISSUER} idp-john` })
    idTokenClaims = { sub: 'g-1', email: 'john.renamed@example.com', email_verified: true, hd: 'example.com' }

    const res = await googleSignIn(app, env)
    expect(res.headers.get('location')).toBe('/login?error=sso')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('__Host-glance_session=')
  })

  test('without the sync, Google still signs that account in and links the googleId', async () => {
    const { app, env, db } = setup(GOOGLE_ENV)
    await db.insert(users).values({ id: 'u', email: 'john.doe@example.com', oidcSub: `${ISSUER} idp-john` })
    idTokenClaims = { sub: 'g-1', email: 'john.doe@example.com', email_verified: true, hd: 'example.com' }

    const res = await googleSignIn(app, env)
    expect(res.headers.get('location')).toBe('/dashboard')
    expect((await db.select().from(users))[0]).toMatchObject({ id: 'u', googleId: 'g-1' })
  })
})
