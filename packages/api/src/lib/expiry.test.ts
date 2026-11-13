import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { checkAccess } from './access'
import { expireDueSites, parseExpiry } from './expiry'

const NOW = new Date('2026-06-01T12:00:00.000Z')
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
const HOUR = 3_600_000

describe('parseExpiry', () => {
  test('relative values use the supplied clock; a bare date is the end of that UTC day; an ISO instant is kept', () => {
    expect(parseExpiry('30m', NOW)).toEqual({ kind: 'set', at: at(30 * 60_000) })
    expect(parseExpiry('2W', NOW)).toEqual({ kind: 'set', at: at(14 * 24 * HOUR) })
    expect(parseExpiry('2026-12-31', NOW)).toEqual({ kind: 'set', at: '2026-12-31T23:59:59.999Z' })
    expect(parseExpiry('2026-12-31T10:00:00Z', NOW)).toEqual({ kind: 'set', at: '2026-12-31T10:00:00.000Z' })
  })

  test('none / never / empty / null clear; garbage, the past, under a minute, over five years, non-strings are refused', () => {
    for (const v of ['none', 'NEVER', '  ', null]) expect(parseExpiry(v, NOW)).toEqual({ kind: 'clear' })
    for (const v of ['soon', '2026-05-31', '30s', '2040-01-01', 7]) expect(parseExpiry(v, NOW).kind).toBe('invalid')
  })
})

describe('expireDueSites', () => {
  test('flips only active sites past due; archived, future and never are untouched', async () => {
    const db = makeDb()
    const owner = await seedUser(db, { id: 'owner' })
    const sp = await seedSpace(db, { createdBy: owner, slug: 'acme' })
    await seedMember(db, sp, owner)
    const mk = (id: string, o: { expiresAt?: string | null; status?: 'active' | 'archived' }) =>
      seedSite(db, { id, spaceId: sp, ownerId: owner, slug: id, ...o })
    await mk('due', { expiresAt: at(-HOUR) })
    await mk('future', { expiresAt: at(HOUR) })
    await mk('never', {})
    await mk('admin', { expiresAt: at(-HOUR), status: 'archived' })

    expect(await expireDueSites(db, NOW)).toBe(1)
    const status = async (id: string) => (await db.select({ s: sites.status }).from(sites).where(eq(sites.id, id)))[0]?.s
    expect([await status('due'), await status('future'), await status('never'), await status('admin')]).toEqual([
      'expired',
      'active',
      'active',
      'archived',
    ])
  })
})

describe('checkAccess — expiry', () => {
  const owner = { id: 'o', role: 'member' as const }
  const base = { visibility: 'team' as const, ownerId: 'o' }

  test('expired is 410 for everyone, tagged as expiry; an active site past its expiresAt is refused before the sweep; archived has no tag', () => {
    expect(checkAccess({ ...base, status: 'expired' }, owner, true)).toEqual({ ok: false, status: 410, reason: 'expired' })
    expect(checkAccess({ ...base, status: 'active', expiresAt: at(-1) }, owner, true, false, NOW)).toEqual({ ok: false, status: 410, reason: 'expired' })
    expect(checkAccess({ ...base, status: 'active', expiresAt: at(HOUR) }, owner, true, false, NOW)).toEqual({ ok: true })
    expect(checkAccess({ ...base, status: 'archived' }, owner, true)).toEqual({ ok: false, status: 410 })
  })
})
