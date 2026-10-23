import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { spaceMembers, spaces, users } from '../db/schema'
import { resetOidcDiscovery } from '../lib/oidc'
import { makeDb, makeKv } from '../test/harness'
import type { AppEnv } from '../types'
import { auth } from './auth'

const APP_URL = 'https://glance.example.com'
const ISSUER = 'https://idp.example.com'
const AUTHORIZE = `${ISSUER}/oauth2/v1/authorize`
const TOKEN = `${ISSUER}/oauth2/v1/token`

const realFetch = globalThis.fetch
let tokenRequests: URLSearchParams[] = []
let idTokenClaims: Record<string, unknown> = {}
let discoveryIssuer = ISSUER

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`

beforeEach(() => {
  resetOidcDiscovery()
  tokenRequests = []
  discoveryIssuer = ISSUER
  idTokenClaims = claims()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    if (req.url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: discoveryIssuer, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN })
    }
    if (req.url === TOKEN) {
      tokenRequests.push(new URLSearchParams(await req.text()))
      return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken(idTokenClaims) })
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

    const row = (await db.select().from(users).where(eq(users.oidcSub, 'idp-john')))[0]
    expect(row).toMatchObject({ email: 'john.doe@example.com', name: 'John Doe', role: 'member', googleId: null })
    const personal = await db.select().from(spaces).where(eq(spaces.createdBy, row.id))
    expect(personal.map((s) => s.type)).toEqual(['personal'])
  })

  test('a later sign-in by email links the subject onto the existing (e.g. bootstrap) user', async () => {
    const { app, env, db } = setup()
    await db.insert(users).values({ id: 'boot', email: 'john.doe@example.com', role: 'superadmin' })

    await signIn(app, env)

    const rows = await db.select().from(users)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'boot', oidcSub: 'idp-john', role: 'superadmin' })
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

  test('a callback whose state does not match the cookie is refused before any exchange', async () => {
    const { app, env } = setup()
    const start = await app.request('/api/auth/oidc', {}, env)
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]
    const res = await app.request('/api/auth/oidc/callback?code=c&state=forged', { headers: { cookie } }, env)
    expect(res.headers.get('location')).toBe('/login?error=state')
    expect(tokenRequests).toHaveLength(0)
  })

  test('groups in the id_token become managed team spaces the user belongs to', async () => {
    const { app, env, db } = setup({ OIDC_GROUP_PREFIX: 'app.glance.' })
    idTokenClaims = claims({ groups: ['app.glance.Platform', 'Everyone'] })

    await signIn(app, env)

    const user = (await db.select().from(users))[0]
    const managed = await db
      .select({ slug: spaces.slug, name: spaces.name, oidcGroup: spaces.oidcGroup })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, user.id))
    expect(managed.filter((s) => s.oidcGroup !== null)).toEqual([
      { slug: 'platform', name: 'Platform', oidcGroup: 'app.glance.Platform' },
    ])
  })
})
