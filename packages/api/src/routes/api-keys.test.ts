import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { API_KEY_PREFIX } from '../lib/api-key'
import { apiKeys as apiKeysTable } from '../db/schema'
import { FULL_GRANTS, seedApiKey } from '../test/harness'
import { auth, authKey, makeRouteApp, mintKey, mintUser } from '../test/route-fixtures'
import { KEY_DURATIONS, MAX_ACTIVE_KEYS } from './api-keys'

async function scenario() {
  // Real production wiring (makeRouteApp mounts this router the way index.ts does), so these
  // tests also prove /api/api-keys is reachable in the assembled app, not just in isolation.
  const { app, db, kv, env } = makeRouteApp()
  await mintUser(db, kv, 'owner')
  await mintUser(db, kv, 'other')
  // Bound request helper: the CLI Bearer path (auth()) needs GLANCE_SESSIONS on env, so env
  // travels with app/db rather than being threaded through every call site.
  // Hono's `.get('/')`/`.post('/')` on a sub-router match the mount path with NO trailing slash
  // (see whats-new.test.ts) — '/' here means "the router root", not a literal trailing slash.
  const req = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
    app.request(
      `/api/api-keys${path === '/' ? '' : path}`,
      { method, headers, body: body ? JSON.stringify(body) : undefined },
      env,
    )
  return { db, kv, app, env, req }
}

describe('POST /api/api-keys — mint', () => {
  test('CASE-13: mint returns the secret once; the GET list response body NEVER contains it', async () => {
    const { req } = await scenario()
    const mintRes = await req(auth('owner'), 'POST', '/', { name: 'ci key', expiresInDays: 30, grants: FULL_GRANTS })
    expect(mintRes.status).toBe(201)
    const minted = await mintRes.json()
    expect(typeof minted.secret).toBe('string')
    expect(minted.secret.startsWith('glk_')).toBe(true)

    const listRes = await req(auth('owner'), 'GET', '/')
    const listBody = await listRes.text()
    expect(listBody).not.toContain(minted.secret)

    // The secret returned above must actually work as a Bearer token — proves the stored hash
    // matches what was minted, not merely that SOME secret was returned.
    const authRes = await req(authKey(minted.secret), 'GET', '/')
    expect(authRes.status).toBe(200)
  })

  test('mint sets Cache-Control: no-store', async () => {
    const { req } = await scenario()
    const res = await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 7, grants: FULL_GRANTS })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('CASE-14a: expiresInDays outside the fixed duration set is rejected', async () => {
    const { req } = await scenario()
    const res = await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 45, grants: FULL_GRANTS })
    expect(res.status).toBe(400)
  })

  test('CASE-14b: a body-supplied expiresAt is ignored — server derives it from expiresInDays', async () => {
    const { db, req } = await scenario()
    const tenYearsOut = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()
    const res = await req(auth('owner'), 'POST', '/', {
      name: 'k',
      expiresInDays: 7,
      expiresAt: tenYearsOut,
      grants: FULL_GRANTS,
    })
    expect(res.status).toBe(201)
    const { id } = await res.json()
    const [mine] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, id))
    expect(mine.expiresAt).not.toBe(tenYearsOut)
    const expected = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    expect(Math.abs(new Date(mine.expiresAt).getTime() - expected.getTime())).toBeLessThan(5000)
  })

  test('malformed grants blob → 400', async () => {
    const { req } = await scenario()
    const res = await req(auth('owner'), 'POST', '/', {
      name: 'k',
      expiresInDays: 30,
      grants: { control: 'yes', data: null },
    })
    expect(res.status).toBe(400)
  })

  test('empty/whitespace-only name → 400', async () => {
    const { req } = await scenario()
    const res = await req(auth('owner'), 'POST', '/', { name: '   ', expiresInDays: 30, grants: FULL_GRANTS })
    expect(res.status).toBe(400)
  })

  test('name over the max length → 400', async () => {
    const { req } = await scenario()
    const res = await req(auth('owner'), 'POST', '/', { name: 'x'.repeat(201), expiresInDays: 30, grants: FULL_GRANTS })
    expect(res.status).toBe(400)
  })

  test('unauthenticated mint → 401', async () => {
    const { req } = await scenario()
    const res = await req({ 'Content-Type': 'application/json' }, 'POST', '/', {
      name: 'k',
      expiresInDays: 30,
      grants: FULL_GRANTS,
    })
    expect(res.status).toBe(401)
  })

  test('the fixed duration set is exactly [1, 7, 30, 90, 180, 365]', () => {
    expect(KEY_DURATIONS).toEqual([1, 7, 30, 90, 180, 365])
  })

  test('a key-authenticated mint is 403’d, regardless of its grants', async () => {
    const { db, req } = await scenario()
    const secret = await mintKey(db, 'owner')
    const res = await req(authKey(secret), 'POST', '/', { name: 'backdoor', expiresInDays: 365, grants: FULL_GRANTS })
    expect(res.status).toBe(403)
    const list = await req(auth('owner'), 'GET', '/')
    const { items } = await list.json()
    expect(items.map((k: { name: string }) => k.name)).not.toContain('backdoor')
  })

  test('CASE-19: the (cap+1)th active key is rejected; revoking one frees a slot; expired/revoked keys do not count', async () => {
    const { db, req } = await scenario()
    // Pre-fill with an EXPIRED key and a REVOKED key — neither should count against the cap.
    await seedApiKey(db, { userId: 'owner', expiresAt: new Date(Date.now() - 1000).toISOString() })
    await seedApiKey(db, { userId: 'owner', revokedAt: new Date().toISOString() })

    const ids: string[] = []
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      const res = await req(auth('owner'), 'POST', '/', { name: `k${i}`, expiresInDays: 30, grants: FULL_GRANTS })
      expect(res.status).toBe(201)
      ids.push((await res.json()).id)
    }
    const overCap = await req(auth('owner'), 'POST', '/', { name: 'over', expiresInDays: 30, grants: FULL_GRANTS })
    expect(overCap.status).toBe(400)

    // Revoking one frees a slot.
    const revoke = await req(auth('owner'), 'DELETE', `/${ids[0]}`)
    expect(revoke.status).toBe(200)
    const afterRevoke = await req(auth('owner'), 'POST', '/', {
      name: 'after-revoke',
      expiresInDays: 30,
      grants: FULL_GRANTS,
    })
    expect(afterRevoke.status).toBe(201)
  })

  test('the active-key cap is exactly 10', () => {
    expect(MAX_ACTIVE_KEYS).toBe(10)
  })

  test("the cap only counts the CALLER's own keys — another user's active keys don't consume it", async () => {
    const { db, req } = await scenario()
    // 'other' has MAX_ACTIVE_KEYS active keys already; 'owner' has none.
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      await seedApiKey(db, { userId: 'other', name: `other-${i}` })
    }
    const res = await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 30, grants: FULL_GRANTS })
    expect(res.status).toBe(201)
  })
})

describe('GET /api/api-keys — list', () => {
  test('lists newest first with the expected fields, and a revoked key stays (tombstone)', async () => {
    const { req } = await scenario()
    const first = await req(auth('owner'), 'POST', '/', { name: 'first', expiresInDays: 30, grants: FULL_GRANTS })
    const firstId = (await first.json()).id
    await req(auth('owner'), 'POST', '/', { name: 'second', expiresInDays: 30, grants: FULL_GRANTS })

    await req(auth('owner'), 'DELETE', `/${firstId}`)

    const list = await req(auth('owner'), 'GET', '/')
    expect(list.status).toBe(200)
    const { items } = await list.json()
    expect(items).toHaveLength(2)
    expect(items.map((k: { name: string }) => k.name)).toEqual(['second', 'first'])
    const revoked = items.find((k: { name: string }) => k.name === 'first')
    expect(revoked.revokedAt).not.toBeNull()
    for (const k of items) {
      expect(k).toHaveProperty('name')
      expect(k.grants).toEqual(FULL_GRANTS)
      expect(k).toHaveProperty('createdAt')
      expect(k).toHaveProperty('expiresAt')
      expect(k).toHaveProperty('revokedAt')
      expect(k).toHaveProperty('lastUsedAt')
      expect(k).not.toHaveProperty('hash')
    }
  })

  test('secretHint is the prefix plus ONLY the last 4 characters of the secret — nothing more', async () => {
    const { req } = await scenario()
    const mintRes = await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 30, grants: FULL_GRANTS })
    const minted = await mintRes.json()

    const list = await req(auth('owner'), 'GET', '/')
    const { items } = await list.json()
    // Exact equality pins both the prefix/ellipsis framing AND the length of the suffix — a
    // longer slice (e.g. the last 20 chars instead of 4) would fail this, not just toHaveProperty.
    expect(items[0].secretHint).toBe(`${API_KEY_PREFIX}…${minted.secret.slice(-4)}`)
  })

  // The test above reads the RENDERED hint, so it stays green even if the column behind it holds
  // the whole plaintext and the route slices it down on the way out. What must never happen is
  // the secret being AT REST in a recoverable form — assert the stored column directly.
  test('the stored displaySuffix is only the last 4 characters — the secret is not at rest anywhere', async () => {
    const { req, db } = await scenario()
    const minted = await (await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 30, grants: FULL_GRANTS })).json()

    const [row] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, minted.id))
    expect(row.displaySuffix).toBe(minted.secret.slice(-4))
    expect(JSON.stringify(row)).not.toContain(minted.secret)
  })

  // The tombstone requirement has two halves and only the revoked one was pinned. An EXPIRED key
  // must stay listed too: the row is what the user clicks to delete, so filtering it out of the
  // list would strand it — visible nowhere, still occupying nothing, impossible to clean up.
  test('an EXPIRED key stays in the list (the other half of the tombstone)', async () => {
    const { req, db } = await scenario()
    await seedApiKey(db, { userId: 'owner', name: 'stale', expiresAt: new Date(Date.now() - 1000).toISOString() })

    const { items } = await (await req(auth('owner'), 'GET', '/')).json()
    expect(items.map((k: { name: string }) => k.name)).toEqual(['stale'])
  })

  // Rows minted before migration 0026 have no displaySuffix. The hint must degrade to null rather
  // than rendering the literal string "glk_…null" into the keys screen.
  test('a pre-0026 row with no displaySuffix lists with a null secretHint, not "…null"', async () => {
    const { req, db } = await scenario()
    await seedApiKey(db, { userId: 'owner', name: 'legacy' })

    const { items } = await (await req(auth('owner'), 'GET', '/')).json()
    expect(items[0].secretHint).toBeNull()
  })

  test("only lists the caller's own keys", async () => {
    const { req } = await scenario()
    await req(auth('owner'), 'POST', '/', { name: 'owner key', expiresInDays: 30, grants: FULL_GRANTS })
    await req(auth('other'), 'POST', '/', { name: 'other key', expiresInDays: 30, grants: FULL_GRANTS })
    const list = await req(auth('owner'), 'GET', '/')
    const { items } = await list.json()
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('owner key')
  })

  test('a key can authenticate to its own routes too', async () => {
    const { db, req } = await scenario()
    const secret = await mintKey(db, 'owner')
    const res = await req(authKey(secret), 'GET', '/')
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/api-keys/:id — revoke', () => {
  test("CASE-15: revoking another user's key returns 404, not 403", async () => {
    const { req } = await scenario()
    const mintRes = await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 30, grants: FULL_GRANTS })
    const { id } = await mintRes.json()
    const res = await req(auth('other'), 'DELETE', `/${id}`)
    expect(res.status).toBe(404)
  })

  test('revoking is idempotent — revoking an already-revoked key is still a success', async () => {
    const { req } = await scenario()
    const mintRes = await req(auth('owner'), 'POST', '/', { name: 'k', expiresInDays: 30, grants: FULL_GRANTS })
    const { id } = await mintRes.json()
    expect((await req(auth('owner'), 'DELETE', `/${id}`)).status).toBe(200)
    expect((await req(auth('owner'), 'DELETE', `/${id}`)).status).toBe(200)
  })

  test('revoking an unknown id returns 404', async () => {
    const { req } = await scenario()
    const res = await req(auth('owner'), 'DELETE', '/does-not-exist')
    expect(res.status).toBe(404)
  })

  test('unauthenticated revoke → 401', async () => {
    const { req } = await scenario()
    const res = await req({ 'Content-Type': 'application/json' }, 'DELETE', '/does-not-exist')
    expect(res.status).toBe(401)
  })

  // A leaked key must not be able to mint a backdoor key (see the mint describe block above) OR
  // revoke the user's OTHER keys — either would let a leaked key outlive its own revocation.
  // Checked BEFORE the ownership lookup (same ordering as sites.ts DELETE), so a key learns
  // nothing about which ids exist either.
  test("a key-authenticated revoke is 403’d, even against the SAME key's own owner's other keys", async () => {
    const { db, req } = await scenario()
    const victim = await req(auth('owner'), 'POST', '/', { name: 'victim', expiresInDays: 30, grants: FULL_GRANTS })
    const { id: victimId } = await victim.json()
    const secret = await mintKey(db, 'owner')

    const res = await req(authKey(secret), 'DELETE', `/${victimId}`)
    expect(res.status).toBe(403)

    const list = await req(auth('owner'), 'GET', '/')
    const { items } = await list.json()
    expect(items.find((k: { id: string }) => k.id === victimId).revokedAt).toBeNull()
  })

  test('a key-authenticated revoke of a NONEXISTENT id is still 403, not 404', async () => {
    const { db, req } = await scenario()
    const secret = await mintKey(db, 'owner')
    const res = await req(authKey(secret), 'DELETE', '/does-not-exist')
    expect(res.status).toBe(403)
  })
})
