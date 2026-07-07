import { describe, expect, test } from 'bun:test'
import type { SessionUser } from '../types'
import { makeDb, seedGroupShare, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import { searchSites } from './sites'

const member = (id: string): SessionUser => ({ id, email: `${id}@example.com`, name: null, role: 'member' })
const superadmin = (id: string): SessionUser => ({ id, email: `${id}@example.com`, name: null, role: 'superadmin' })
const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id))

// searchSites is the "openable" search surface: one bounded candidate query then an
// in-memory checkAccess pass (the single source of truth). These specs exercise every tier.
describe('searchSites (cmdk site search)', () => {
  test('search-owner-sees-own-private: owner finds their own private site', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const sp = await seedSpace(db, { createdBy: me })
    const site = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'secret-deck', visibility: 'private' })
    expect(ids(await searchSites(db, member(me), 'secret')).has(site)).toBe(true)
  })

  test('search-member-sees-group-site-in-their-space: the tier every existing endpoint misses', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner })
    await seedMember(db, sp, me) // member, NOT owner
    const site = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'group-plan', visibility: 'members' })
    expect(ids(await searchSites(db, member(me), 'group-plan')).has(site)).toBe(true)
  })

  test('search-nonmember-excluded: non-member sees neither the group nor the private site', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner }) // me is NOT a member
    const group = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'grp-x', visibility: 'members' })
    const priv = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'prv-x', visibility: 'private' })
    const res = ids(await searchSites(db, member(me), 'x'))
    expect(res.has(group)).toBe(false)
    expect(res.has(priv)).toBe(false)
  })

  test('search-team-visible-to-any-member', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner }) // me not a member
    const team = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'tm-feed', visibility: 'team' })
    const priv = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'pv-feed', visibility: 'private' })
    const res = ids(await searchSites(db, member(me), 'feed'))
    expect(res.has(team)).toBe(true)
    expect(res.has(priv)).toBe(false) // private in a space me isn't a member of
  })

  test('search-explicit-share-included: direct share and via-group share both included', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner })
    const direct = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'direct-share', visibility: 'private' })
    await seedUserShare(db, direct, me)
    const grp = await seedSpace(db, { createdBy: owner })
    await seedMember(db, grp, me)
    const viaGroup = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'group-share', visibility: 'private' })
    await seedGroupShare(db, viaGroup, grp)
    const res = ids(await searchSites(db, member(me), 'share'))
    expect(res.has(direct)).toBe(true)
    expect(res.has(viaGroup)).toBe(true)
  })

  test('search-q-matches-title-slug-space: q matches site title, slug, or its space', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const neutral = await seedSpace(db, { createdBy: me, slug: 'neutral' })
    const byTitle = await seedSite(db, { spaceId: neutral, ownerId: me, slug: 's1', title: 'Alpha Report', visibility: 'team' })
    const bySlug = await seedSite(db, { spaceId: neutral, ownerId: me, slug: 'alpha-deck', visibility: 'team' })
    const alphaSpace = await seedSpace(db, { createdBy: me, slug: 'alpha-zone' })
    const bySpace = await seedSite(db, { spaceId: alphaSpace, ownerId: me, slug: 'zzz', title: 'Nothing', visibility: 'team' })
    const res = ids(await searchSites(db, member(me), 'alpha'))
    expect(res.has(byTitle)).toBe(true)
    expect(res.has(bySlug)).toBe(true)
    expect(res.has(bySpace)).toBe(true)
  })

  test('search-excludes-archived-for-normal-user', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const sp = await seedSpace(db, { createdBy: me })
    const active = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'live-doc', visibility: 'team', status: 'active' })
    const archived = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'old-doc', visibility: 'team', status: 'archived' })
    const res = ids(await searchSites(db, member(me), 'doc'))
    expect(res.has(active)).toBe(true)
    expect(res.has(archived)).toBe(false)
  })

  test('search-superadmin-sees-all-active: every active site, not archived', async () => {
    const db = makeDb()
    await seedUser(db, { id: 'admin', role: 'superadmin' })
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner }) // admin owns none, member of none
    const priv = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'p-doc', visibility: 'private' })
    const group = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'g-doc', visibility: 'members' })
    const team = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 't-doc', visibility: 'team' })
    const archived = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'a-doc', visibility: 'team', status: 'archived' })
    const res = ids(await searchSites(db, superadmin('admin'), 'doc'))
    expect(res.has(priv)).toBe(true)
    expect(res.has(group)).toBe(true)
    expect(res.has(team)).toBe(true)
    expect(res.has(archived)).toBe(false)
  })

  test('search-caps-results: more than the cap seeded → at most the cap returned', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const sp = await seedSpace(db, { createdBy: me })
    for (let i = 0; i < 25; i++) {
      await seedSite(db, { spaceId: sp, ownerId: me, slug: `cap-${i}`, visibility: 'team' })
    }
    expect((await searchSites(db, member(me), 'cap', 20)).length).toBe(20)
  })

  test('search-escapes-like-wildcards: %/_ in q are literal, not wildcards', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const sp = await seedSpace(db, { createdBy: me, slug: 'neutral' })
    // '%' must match a literal percent, not "any run of chars" — else '50%' would match '50xyz'.
    const pct = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'deck', title: '50% Off Deck', visibility: 'team' })
    const plain = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'report', title: '50xyz report', visibility: 'team' })
    const res = ids(await searchSites(db, member(me), '50%'))
    expect(res.has(pct)).toBe(true)
    expect(res.has(plain)).toBe(false)

    // '_' must match a literal underscore, not "any single char" — else 'a_b' would match 'axb'.
    const under = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'u-doc', title: 'a_b spec', visibility: 'team' })
    const other = await seedSite(db, { spaceId: sp, ownerId: me, slug: 'axb', title: 'axb spec', visibility: 'team' })
    const res2 = ids(await searchSites(db, member(me), 'a_b'))
    expect(res2.has(under)).toBe(true)
    expect(res2.has(other)).toBe(false)
  })

  test('search-chunks-large-shared-set: >1 param-chunk of shared ids unions correctly', async () => {
    const db = makeDb()
    const me = await seedUser(db, { id: 'me' })
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner }) // me not a member — reachable only via share
    // 95 private sites shared directly with me → the shared-id inArray spans >1 90-param chunk.
    for (let i = 0; i < 95; i++) {
      const slug = i === 50 ? 'sd-needle' : `sd-${i}`
      const site = await seedSite(db, { spaceId: sp, ownerId: owner, slug, visibility: 'private' })
      await seedUserShare(db, site, me)
    }
    // Broad query spans both chunks without error and stays capped at the limit.
    expect((await searchSites(db, member(me), 'sd', 20)).length).toBe(20)
    // A needle whose id lands in some chunk is still found (union across chunks, not just the first).
    expect(ids(await searchSites(db, member(me), 'needle')).size).toBe(1)
  })
})
