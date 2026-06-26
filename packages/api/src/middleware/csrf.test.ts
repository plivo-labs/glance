import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { requireSameOrigin } from './auth'

const APP_URL = 'https://glance.example.com'
const env = { APP_URL } as AppEnv['Bindings']

const app = new Hono<AppEnv>()
app.use('/api/*', requireSameOrigin)
app.post('/api/thing', (c) => c.json({ ok: true }))
app.get('/api/thing', (c) => c.json({ ok: true }))

const cookie = 'glance_session=signed-token'

describe('requireSameOrigin', () => {
  test('cookie POST with foreign Origin → 403', async () => {
    const res = await app.request('/api/thing', { method: 'POST', headers: { cookie, Origin: 'https://evil.com' } }, env)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'csrf' })
  })

  test('cookie POST with matching Origin → passes', async () => {
    const res = await app.request('/api/thing', { method: 'POST', headers: { cookie, Origin: APP_URL } }, env)
    expect(res.status).toBe(200)
  })

  test('cookie POST with Sec-Fetch-Site: same-origin → passes', async () => {
    const headers = { cookie, 'Sec-Fetch-Site': 'same-origin' }
    const res = await app.request('/api/thing', { method: 'POST', headers }, env)
    expect(res.status).toBe(200)
  })

  test('no cookie + cross-origin (Bearer CLI) → passes', async () => {
    const headers = { Origin: 'https://evil.com', Authorization: 'Bearer cli-token' }
    const res = await app.request('/api/thing', { method: 'POST', headers }, env)
    expect(res.status).toBe(200)
  })

  test('cookie GET with foreign Origin → passes', async () => {
    const res = await app.request('/api/thing', { method: 'GET', headers: { cookie, Origin: 'https://evil.com' } }, env)
    expect(res.status).toBe(200)
  })

  test('cookie POST with NO Origin and NO Sec-Fetch-Site → 403 (fail-closed)', async () => {
    const res = await app.request('/api/thing', { method: 'POST', headers: { cookie } }, env)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'csrf' })
  })
})
