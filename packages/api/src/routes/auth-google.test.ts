import { describe, expect, test } from 'bun:test'
import type { AppEnv } from '../types'
import { auth } from './auth'

const base = {
  APP_URL: 'https://glance.example.com',
  SESSION_SECRET: 'test-session-secret',
  ALLOWED_HD: 'example.com',
} as AppEnv['Bindings']

describe('GET /google guard (creds optional)', () => {
  test('google-route-500-without-creds: unset creds → clean 404, never a thrown 500', async () => {
    const res = await auth.request('/google', { method: 'GET' }, base)
    expect(res.status).toBe(404)
  })

  test('google-route-redirects-when-configured: creds set → 302 to accounts.google.com', async () => {
    const env = { ...base, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' } as AppEnv['Bindings']
    const res = await auth.request('/google', { method: 'GET' }, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain('accounts.google.com')
  })

  test('GET /callback with unset creds → 404 (never constructs Google)', async () => {
    const res = await auth.request('/callback?code=x&state=y', { method: 'GET' }, base)
    expect(res.status).toBe(404)
  })
})
