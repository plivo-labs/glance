import { describe, expect, test } from 'bun:test'
import type { AppEnv } from '../types'
import { isGoogleEnabled } from './oauth'
import { bootstrapDecision, buildPublicConfig, secretEquals } from './bootstrap'

const TOKEN = 'expected-bootstrap-token'

describe('secretEquals (constant-time)', () => {
  test('secretEquals-correctness: equal → true; unequal & length-mismatch → false', async () => {
    expect(await secretEquals('abc123', 'abc123')).toBe(true)
    expect(await secretEquals('abc123', 'abc124')).toBe(false) // same length, differ
    expect(await secretEquals('abc', 'abcdef')).toBe(false) // length mismatch
    expect(await secretEquals('', '')).toBe(true)
    expect(await secretEquals('x', '')).toBe(false)
  })
})

describe('bootstrapDecision (pure)', () => {
  test('decision-no-token-configured-404: expectedToken unset → inert 404', async () => {
    const d = await bootstrapDecision({
      expectedToken: undefined,
      providedToken: 'anything',
      status: async () => ({ hasSuperadmin: false, superadminIsConfiguredEmail: false }),
    })
    expect(d).toEqual({ ok: false, status: 404 })
  })

  test('decision-bad-token-rejected: wrong token → 401', async () => {
    const d = await bootstrapDecision({
      expectedToken: TOKEN,
      providedToken: 'wrong',
      status: async () => ({ hasSuperadmin: false, superadminIsConfiguredEmail: false }),
    })
    expect(d).toEqual({ ok: false, status: 401 })
  })

  test('decision-good-token-no-superadmin-ok', async () => {
    const d = await bootstrapDecision({
      expectedToken: TOKEN,
      providedToken: TOKEN,
      status: async () => ({ hasSuperadmin: false, superadminIsConfiguredEmail: false }),
    })
    expect(d).toEqual({ ok: true })
  })

  test('decision-good-token-existing-configured-superadmin-ok: idempotent re-mint', async () => {
    const d = await bootstrapDecision({
      expectedToken: TOKEN,
      providedToken: TOKEN,
      status: async () => ({ hasSuperadmin: true, superadminIsConfiguredEmail: true }),
    })
    expect(d).toEqual({ ok: true })
  })

  test('decision-different-superadmin-exists-410', async () => {
    const d = await bootstrapDecision({
      expectedToken: TOKEN,
      providedToken: TOKEN,
      status: async () => ({ hasSuperadmin: true, superadminIsConfiguredEmail: false }),
    })
    expect(d).toEqual({ ok: false, status: 410 })
  })

  test('a bad token never leaks superadmin state (401) and never reads DB status', async () => {
    let statusReads = 0
    const d = await bootstrapDecision({
      expectedToken: TOKEN,
      providedToken: 'wrong',
      status: async () => {
        statusReads++
        return { hasSuperadmin: true, superadminIsConfiguredEmail: false }
      },
    })
    expect(d).toEqual({ ok: false, status: 401 })
    expect(statusReads).toBe(0) // reject path does no I/O
  })

  test('an unset token is inert (404) and never reads DB status', async () => {
    let statusReads = 0
    const d = await bootstrapDecision({
      expectedToken: undefined,
      providedToken: TOKEN,
      status: async () => {
        statusReads++
        return { hasSuperadmin: false, superadminIsConfiguredEmail: false }
      },
    })
    expect(d).toEqual({ ok: false, status: 404 })
    expect(statusReads).toBe(0)
  })
})

describe('buildPublicConfig (pure)', () => {
  test('config-shape: bootstrapAvailable iff token set AND no superadmin; googleEnabled passthrough', () => {
    expect(buildPublicConfig({ googleEnabled: true, hasSuperadmin: false, bootstrapTokenSet: true })).toEqual({
      googleEnabled: true,
      bootstrapAvailable: true,
    })
    expect(buildPublicConfig({ googleEnabled: false, hasSuperadmin: true, bootstrapTokenSet: true })).toEqual({
      googleEnabled: false,
      bootstrapAvailable: false,
    })
    expect(buildPublicConfig({ googleEnabled: false, hasSuperadmin: false, bootstrapTokenSet: false })).toEqual({
      googleEnabled: false,
      bootstrapAvailable: false,
    })
  })

  test('config-shape: googleEnabled true only when BOTH client id+secret set', () => {
    const env = (o: Partial<AppEnv['Bindings']>) => o as AppEnv['Bindings']
    expect(isGoogleEnabled(env({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }))).toBe(true)
    expect(isGoogleEnabled(env({ GOOGLE_CLIENT_ID: 'a' }))).toBe(false)
    expect(isGoogleEnabled(env({ GOOGLE_CLIENT_SECRET: 'b' }))).toBe(false)
    expect(isGoogleEnabled(env({}))).toBe(false)
  })
})
