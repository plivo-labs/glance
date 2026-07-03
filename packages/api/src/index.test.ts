import { describe, expect, test } from 'bun:test'
import app from './index'

// Composition-level checks against the real root app (routes registered before the /api/* guards
// need no DB, so a minimal env suffices).
const ENV = { CONTENT_URL: 'https://content.example.com', APP_URL: 'https://glance.example.com' } as never

describe('shared-backend routes on the root app', () => {
  test('/api/glance.js serves the SDK with the global CSP applied', async () => {
    const res = await app.request('/api/glance.js', {}, ENV)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
  })

  test('no demo page ships (deleted — rebuilt broker-side in Phase 2)', async () => {
    const res = await app.request('/api/glance-demo', {}, ENV)
    expect(res.status).not.toBe(200)
  })
})
