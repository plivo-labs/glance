import { describe, expect, test } from 'bun:test'
import { auth, authKey, makeRouteApp, mintKey, mintUser } from '../test/route-fixtures'

describe('POST /api/admin/users/:id/revoke-cli', () => {
  test('CASE-16: also revokes the user’s D1 API keys — the key stops authenticating afterwards', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')
    const secret = await mintKey(db, 'owner')

    // Sanity: the key authenticates before the kill-switch runs.
    const before = await app.request('/api/api-keys', { headers: authKey(secret) }, env)
    expect(before.status).toBe(200)

    const res = await app.request(
      '/api/admin/users/owner/revoke-cli',
      { method: 'POST', headers: auth('admin') },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // The key must stop AUTHENTICATING — not merely have a column changed.
    const after = await app.request('/api/api-keys', { headers: authKey(secret) }, env)
    expect(after.status).toBe(401)
  })

  // The slice added D1-key revocation ALONGSIDE the pre-existing KV sweep, and nothing anywhere
  // characterized that sweep — deleting revokeUserCliTokens from the route left the whole suite
  // green. Both halves of the kill-switch belong under test, or offboarding can silently start
  // leaving CLI tokens live.
  test('still revokes the user’s KV CLI tokens — both halves of the kill-switch', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')

    const before = await app.request('/api/api-keys', { headers: auth('owner') }, env)
    expect(before.status).toBe(200)

    await app.request('/api/admin/users/owner/revoke-cli', { method: 'POST', headers: auth('admin') }, env)

    const after = await app.request('/api/api-keys', { headers: auth('owner') }, env)
    expect(after.status).toBe(401)
    expect(await kv.get('cli:tok-owner')).toBeNull()
  })

  test('idempotent: a second call is a no-op, and a user with no keys is fine', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'nokeys')

    const first = await app.request(
      '/api/admin/users/nokeys/revoke-cli',
      { method: 'POST', headers: auth('admin') },
      env,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })

    const second = await app.request(
      '/api/admin/users/nokeys/revoke-cli',
      { method: 'POST', headers: auth('admin') },
      env,
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true })
  })

  test('does not touch another user’s keys', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')
    await mintUser(db, kv, 'other')
    const otherSecret = await mintKey(db, 'other')

    await app.request('/api/admin/users/owner/revoke-cli', { method: 'POST', headers: auth('admin') }, env)

    const res = await app.request('/api/api-keys', { headers: authKey(otherSecret) }, env)
    expect(res.status).toBe(200)
  })
})
