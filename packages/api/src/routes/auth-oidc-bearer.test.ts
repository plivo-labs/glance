import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { resetOidcDiscovery } from '../lib/oidc'
import { resetOidcKeys } from '../lib/oidc-bearer'
import { makeDb, makeKv } from '../test/harness'
import type { AppEnv } from '../types'
import { auth } from './auth'

const ISSUER = 'https://idp.example.com'
const CLI_CLIENT = 'cli-client'
const realFetch = globalThis.fetch
let jwksFetches = 0
let publicJwks: JsonWebKey[] = []
let signKey: CryptoKey

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url')
const json = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))

async function keypair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string }
  jwk.kid = kid
  return { privateKey: pair.privateKey, jwk }
}

async function jwt(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const head = json({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1' })
  const body = json({
    iss: ISSUER,
    aud: CLI_CLIENT,
    sub: '00u-john',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    opts.key ?? signKey,
    new TextEncoder().encode(`${head}.${body}`),
  )
  return `${head}.${body}.${b64url(sig)}`
}

beforeAll(async () => {
  const k = await keypair('k1')
  signKey = k.privateKey
  publicJwks = [k.jwk]
})

beforeEach(() => {
  resetOidcDiscovery()
  resetOidcKeys()
  jwksFetches = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/keys`,
      })
    }
    if (url === `${ISSUER}/keys`) {
      jwksFetches++
      return Response.json({ keys: publicJwks })
    }
    return new Response('unexpected fetch', { status: 500 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
})

const realNow = Date.now

async function setup(overrides: Partial<AppEnv['Bindings']> = {}) {
  const db = makeDb()
  const env = {
    APP_URL: 'https://glance.example.com',
    SESSION_SECRET: 's',
    ALLOWED_HD: 'example.com',
    SUPERADMIN_EMAIL: 'owner@example.com',
    GLANCE_SESSIONS: makeKv(),
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'web-client',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_CLI_CLIENT_ID: CLI_CLIENT,
    ...overrides,
  } as unknown as AppEnv['Bindings']
  await db
    .insert(users)
    .values({ id: 'u1', email: 'john.doe@example.com', oidcSub: `${ISSUER} 00u-john`, role: 'member' })
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/auth', auth)
  const me = async (token: string) =>
    app.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }, env)
  return { app, env, me, db }
}

describe('provider-issued bearer tokens', () => {
  test('a valid ID token authenticates the user who signed in with that subject', async () => {
    const { me } = await setup()
    const res = await me(await jwt({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'u1', email: 'john.doe@example.com' })
  })

  test('the signing keys are fetched once and reused', async () => {
    const { me } = await setup()
    await me(await jwt({}))
    await me(await jwt({}))
    expect(jwksFetches).toBe(1)
  })

  for (const [label, claims] of [
    ['another issuer', { iss: 'https://evil.example.com' }],
    ['another audience', { aud: 'some-other-client' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 600 }],
    ['a token that is not valid yet', { nbf: Math.floor(Date.now() / 1000) + 600 }],
    ['a subject nobody signed in with', { sub: '00u-stranger' }],
  ] as const) {
    test(`${label} is refused`, async () => {
      const { me } = await setup()
      expect((await me(await jwt(claims))).status).toBe(401)
    })
  }

  test('a token signed with a key the provider does not publish is refused', async () => {
    const { me } = await setup()
    const other = await keypair('k1')
    expect((await me(await jwt({}, { key: other.privateKey }))).status).toBe(401)
  })

  test('alg none and a forged alg are refused', async () => {
    const { me } = await setup()
    expect((await me(await jwt({}, { alg: 'none' }))).status).toBe(401)
    expect((await me(await jwt({}, { alg: 'HS256' }))).status).toBe(401)
  })

  test('an unknown kid refetches the keys once a minute at most', async () => {
    const { me } = await setup()
    await me(await jwt({}, { kid: 'k9' }))
    await me(await jwt({}, { kid: 'k9' }))
    expect(jwksFetches).toBe(1)
  })

  test('keys for another use or algorithm in the set do not break the valid ones', async () => {
    const { me } = await setup()
    const [signing] = publicJwks
    publicJwks = [
      { ...signing, kid: 'enc', use: 'enc', alg: 'RSA-OAEP' } as JsonWebKey,
      { ...signing, kid: 'broken', n: '!' } as JsonWebKey,
      signing,
    ]
    try {
      expect((await me(await jwt({}))).status).toBe(200)
      expect((await me(await jwt({}, { kid: 'enc' }))).status).toBe(401)
    } finally {
      publicJwks = [signing]
    }
  })

  test('an ID token for several audiences needs azp naming the CLI client', async () => {
    const { me } = await setup()
    expect((await me(await jwt({ aud: [CLI_CLIENT, 'other'] }))).status).toBe(401)
    expect((await me(await jwt({ aud: [CLI_CLIENT, 'other'], azp: 'other' }))).status).toBe(401)
    expect((await me(await jwt({ aud: [CLI_CLIENT, 'other'], azp: CLI_CLIENT }))).status).toBe(200)
  })

  test('a key the provider withdrew stops being trusted once the cached set is an hour old', async () => {
    const { me } = await setup()
    const [signing] = publicJwks
    const token = await jwt({ exp: Math.floor(realNow() / 1000) + 3 * 3600 })
    try {
      expect((await me(token)).status).toBe(200)
      publicJwks = []
      expect((await me(token)).status).toBe(200) // still cached
      Date.now = () => realNow() + 61 * 60_000
      expect((await me(token)).status).toBe(401)
    } finally {
      publicJwks = [signing]
    }
  })

  test('access tokens (custom authorization server) need the audience and the client id', async () => {
    const { me } = await setup({ OIDC_CLI_TOKEN: 'access', OIDC_CLI_AUDIENCE: 'api://glance' })
    expect((await me(await jwt({ aud: 'api://glance', cid: CLI_CLIENT }))).status).toBe(200)
    expect((await me(await jwt({ aud: 'api://glance', cid: 'someone-else' }))).status).toBe(401)
    expect((await me(await jwt({ aud: CLI_CLIENT }))).status).toBe(401)
  })

  test('a custom authorization server has its own issuer, keys and discovery', async () => {
    const custom = 'https://idp.example.com/oauth2/custom'
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === `${custom}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: custom,
          authorization_endpoint: `${custom}/authorize`,
          token_endpoint: `${custom}/token`,
          jwks_uri: `${ISSUER}/keys`,
        })
      }
      return inner(input)
    }) as typeof fetch
    const { me, app, env } = await setup({ OIDC_CLI_ISSUER: custom })
    expect((await me(await jwt({ iss: custom }))).status).toBe(200)
    expect((await me(await jwt({}))).status).toBe(401) // the web issuer's token is not the CLI's
    const config = await (await app.request('/api/auth/cli/config', {}, env)).json()
    expect(config).toMatchObject({ issuer: custom })
  })

  test('the token gets the group sync of a browser sign-in: losing the admin group demotes at once', async () => {
    const { me, db } = await setup({ OIDC_ADMIN_GROUP: 'app.glance.admins' })
    await db.update(users).set({ role: 'superadmin' })

    // No groups claim is "unknown", not "no groups".
    expect(await (await me(await jwt({}))).json()).toMatchObject({ role: 'superadmin' })

    expect(await (await me(await jwt({ groups: ['Everyone'] }))).json()).toMatchObject({ role: 'member' })
    expect((await db.select().from(users).where(eq(users.id, 'u1')))[0]?.role).toBe('member')
  })

  test('revoke-cli refuses tokens from a sign-in before it, refreshed ones included', async () => {
    const { me, db } = await setup()
    const now = Math.floor(Date.now() / 1000)
    await db.update(users).set({ cliRevokedAt: now - 100 })

    expect((await me(await jwt({ auth_time: now - 200, iat: now - 200 }))).status).toBe(401)
    expect((await me(await jwt({ auth_time: now - 200, iat: now }))).status).toBe(401) // refreshed
    expect((await me(await jwt({ iat: now - 200 }))).status).toBe(401) // no auth_time: iat decides
    expect((await me(await jwt({ auth_time: now - 50, iat: now - 50 }))).status).toBe(200) // signed in again
  })

  test('without OIDC_CLI_CLIENT_ID a JWT is just an unknown CLI token', async () => {
    const { me } = await setup({ OIDC_CLI_CLIENT_ID: undefined })
    expect((await me(await jwt({}))).status).toBe(401)
  })

  test('/cli/config tells the CLI how to log in, and is a 404 while the feature is off', async () => {
    const on = await setup({ OIDC_CLI_SCOPE: 'openid offline_access' })
    const res = await on.app.request('/api/auth/cli/config', {}, on.env)
    expect(await res.json()).toEqual({
      issuer: ISSUER,
      clientId: CLI_CLIENT,
      scope: 'openid offline_access',
      tokenUse: 'id',
    })
    const off = await setup({ OIDC_CLI_CLIENT_ID: undefined })
    expect((await off.app.request('/api/auth/cli/config', {}, off.env)).status).toBe(404)
  })
})
