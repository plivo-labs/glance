import { describe, expect, test } from 'bun:test'
import { siteText } from '../lib/site-search'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'
import { makeDb, seedGroupShare, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import type { SessionUser } from '../types'
import { searchSites } from './sites'

const member = (id: string): SessionUser => ({ id, email: `${id}@example.com`, name: null, role: 'member' })

async function world() {
  const db = makeDb()
  const me = await seedUser(db, { id: 'me' })
  const other = await seedUser(db, { id: 'other' })
  const sp = await seedSpace(db, { id: 'sp', createdBy: other }) // `me` is NOT a member
  const site = async (slug: string, text: string, o: Partial<Parameters<typeof seedSite>[1]> = {}) => {
    const id = await seedSite(db, { spaceId: sp, ownerId: other, slug, visibility: 'team', ...o })
    await db.insert(siteText).values({ siteId: id, body: text })
    return id
  }
  return { db, me, other, sp, site, search: (q: string, limit?: number) => searchSites(db, member(me), q, limit) }
}

describe('searchSites — page content', () => {
  test('a content hit carries matchedIn "content" and a snippet around the match', async () => {
    const w = await world()
    const id = await w.site('plain', 'Our quarterly roadmap covers the billing migration.')
    const [hit] = await w.search('billing')
    expect(hit).toMatchObject({ id, matchedIn: 'content' })
    expect(hit?.snippet).toContain('billing')
    expect((await w.search('quarterly roadm')).map((r) => r.id)).toEqual([id]) // the last word matches as a prefix
    expect(await w.search('quarter roadmap')).toEqual([]) // an earlier word does not
  })

  test('name matches come first and a page matching by name AND content is listed once, as a name hit', async () => {
    const w = await world()
    const byContent = await w.site('notes', 'budget discussion')
    const byBoth = await w.site('budget-plan', 'budget numbers')
    const rows = await w.search('budget')
    expect(rows.map((r) => [r.id, r.matchedIn])).toEqual([
      [byBoth, 'name'],
      [byContent, 'content'],
    ])
  })

  test('another user’s private page never appears or leaks text, even in a space `me` belongs to', async () => {
    const w = await world()
    await seedMember(w.db, w.sp, w.me)
    await w.site('priv', 'zebra TOPSECRET plans', { visibility: 'private' })
    const grp = await seedSpace(w.db, { id: 'grp', createdBy: w.other }) // `me` NOT a member
    await w.site('closed', 'zebra TOPSECRET members', { spaceId: grp, visibility: 'members' })
    await w.site('gone', 'zebra TOPSECRET archived', { status: 'archived' })
    const open = await w.site('open', 'zebra is fine here')
    const rows = await w.search('zebra')
    expect(rows.map((r) => r.id)).toEqual([open])
    expect(JSON.stringify(rows)).not.toContain('TOPSECRET')
  })

  test('shared and member-space pages are reachable by content', async () => {
    const w = await world()
    const shared = await w.site('shared', 'otter facts', { visibility: 'private' })
    await seedUserShare(w.db, shared, w.me)
    const grp = await seedSpace(w.db, { id: 'grp', createdBy: w.other })
    await seedMember(w.db, grp, w.me)
    const members = await w.site('members', 'otter habitat', { spaceId: grp, visibility: 'members' })
    const viaGroup = await w.site('via-group', 'otter diet', { visibility: 'private' })
    await seedGroupShare(w.db, viaGroup, grp)
    expect(new Set((await w.search('otter')).map((r) => r.id))).toEqual(new Set([shared, members, viaGroup]))
  })

  // MATCH ... LIMIT before the access filter would let these better-ranked private/archived pages
  // (each group alone over the 50-row limit) push the caller's one page out.
  test('a common word cannot be crowded out by pages the caller cannot open', async () => {
    const w = await world()
    const loud = (n: number) => `common ${'common '.repeat(30)} TOPSECRET-${n}`
    for (let i = 0; i < 55; i++) await w.site(`secret-${i}`, loud(i), { visibility: 'private' })
    for (let i = 0; i < 55; i++) await w.site(`old-${i}`, loud(i), { status: 'archived' })
    const mine = await w.site('mine', 'a single common mention')
    const rows = await w.search('common')
    expect(rows.map((r) => r.id)).toEqual([mine])
    expect(JSON.stringify(rows)).not.toContain('TOPSECRET')
  })
})

describe('searchSites — query injection', () => {
  const nasty = ['"', '" OR "a', 'alpha"', '*', 'NEAR(alpha bravo)', '(alpha', 'alpha AND', 'body:alpha', 'siteId:s*', '^alpha', '-alpha', 'alpha OR zzzz', "'; DROP TABLE site_search; --"]

  test('FTS syntax in q is inert: never throws, never gains operator meaning', async () => {
    const w = await world()
    await w.site('s1', 'alpha bravo')
    for (const q of nasty) await expect(w.search(q)).resolves.toBeInstanceOf(Array)
    // `OR` is just a word here: both terms are required, and "zzzz" is not in the page.
    expect(await w.search('alpha OR zzzz')).toEqual([])
    // A column filter is just words too: it cannot reach the siteId column.
    expect(await w.search('siteId:s1')).toEqual([])
    expect(await w.search('alpha bravo')).toHaveLength(1)
  })

  test('GET /api/sites/search answers 200 with the additive fields for hostile input', async () => {
    const ctx = makeRouteApp()
    await mintUser(ctx.db, ctx.kv, 'me')
    await seedSpace(ctx.db, { id: 'sp', slug: 'sp', createdBy: 'me' })
    const id = await seedSite(ctx.db, { spaceId: 'sp', ownerId: 'me', slug: 'doc', title: 'Doc' })
    await ctx.db.insert(siteText).values({ siteId: id, body: 'harbor lights' })
    const get = (q: string) => ctx.app.request(`/api/sites/search?q=${encodeURIComponent(q)}`, { headers: auth('me') }, ctx.env)
    expect(await (await get('harbor')).json()).toEqual([expect.objectContaining({ id, title: 'Doc', matchedIn: 'content', snippet: expect.stringContaining('harbor') })])
    for (const q of nasty) expect((await get(q)).status).toBe(200)
  })
})
