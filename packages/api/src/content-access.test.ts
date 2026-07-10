// S1 — content serve() auth collapsed to ONE db.batch via the slug-keyed access-facts
// primitive (lib/site-access). Pins first (T1.5 cross-space slug isolation, T1.3 denial
// matrix — writable against the pre-S1 code), then the single-round-trip specs.
import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { siteUserShares, sites, spaceMembers, users } from './db/schema'
import { accessFactsBySlugs } from './lib/site-access'
import { mintToken, setup as setupFixture, teamSite } from './test/content-fixtures'
import { seedFile, seedGroupShare, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from './test/harness'

// Exact statement count of serve()'s single batch for an AUTHED request: the 5 access-facts
// statements (site, user, membership, direct share, group share) + 1 fused file-row statement.
// A legitimate future arity change is a one-line edit HERE.
const SERVE_BATCH_ARITY = 6

// Cache-less wiring: these specs pin today's uncached op shape (getCache resolves null).
const setup = () => setupFixture({ withCaches: false })

type Setup = ReturnType<typeof setup>

const r2OpsTotal = (r2: Setup['r2']) => {
  const o = r2.ops()
  return o.full + o.ranged + o.head + o.onlyIf
}
const cacheOpsTotal = (recorder: Setup['recorder']) =>
  Object.entries(recorder.counters).reduce((n, [k, v]) => (k.startsWith('cache:') ? n + v : n), 0)

/** Assert a denial did its work purely in D1: zero R2 ops AND zero cache ops. */
function expectNoByteWork(s: Setup) {
  expect(r2OpsTotal(s.r2)).toBe(0)
  expect(cacheOpsTotal(s.recorder)).toBe(0)
}

const token = mintToken

// ---------------------------------------------------------------------------------------------
// T1.5 [pin] cross-space slug confusion: two spaces, SAME site slug, same file path,
// different bodies. Nothing about space A may ever select or authorize space B's site.
// ---------------------------------------------------------------------------------------------
describe('T1.5 cross-space same-slug isolation (pin)', () => {
  async function twoSpaces(s: Setup) {
    const { db, r2 } = s
    const ownerA = await seedUser(db)
    const ownerB = await seedUser(db)
    const spA = await seedSpace(db, { createdBy: ownerA, slug: 'space-a' })
    const spB = await seedSpace(db, { createdBy: ownerB, slug: 'space-b' })
    await seedMember(db, spA, ownerA)
    await seedMember(db, spB, ownerB)
    const siteA = await seedSite(db, { spaceId: spA, ownerId: ownerA, slug: 'site', visibility: 'members' })
    const siteB = await seedSite(db, { spaceId: spB, ownerId: ownerB, slug: 'site', visibility: 'members' })
    await seedFile(db, r2, siteA, { path: 'index.html', text: 'BODY-A', storageKey: 'store/a/index.html' })
    await seedFile(db, r2, siteB, { path: 'index.html', text: 'BODY-B', storageKey: 'store/b/index.html' })
    return { ownerA, ownerB, spA, spB, siteA, siteB }
  }

  test('each minted token serves ITS OWN bytes', async () => {
    const s = setup()
    const { ownerA, ownerB } = await twoSpaces(s)
    const resA = await s.app.request(`/_t/${await token(ownerA, 'space-a/site')}/space-a/site/`, {}, s.env)
    expect(resA.status).toBe(200)
    expect(await resA.text()).toBe('BODY-A')
    const resB = await s.app.request(`/_t/${await token(ownerB, 'space-b/site')}/space-b/site/`, {}, s.env)
    expect(resB.status).toBe(200)
    expect(await resB.text()).toBe('BODY-B')
  })

  test("membership in space A doesn't authorize B's same-slug (members) site", async () => {
    const s = setup()
    const { spA } = await twoSpaces(s)
    const memberA = await seedUser(s.db)
    await seedMember(s.db, spA, memberA)
    const res = await s.app.request(`/_t/${await token(memberA, 'space-b/site')}/space-b/site/`, {}, s.env)
    expect(res.status).toBe(403)
    expectNoByteWork(s)
  })

  test("direct share on A's site doesn't select B's same-slug file", async () => {
    const s = setup()
    const { siteA } = await twoSpaces(s)
    const shared = await seedUser(s.db)
    await seedUserShare(s.db, siteA, shared)
    const res = await s.app.request(`/_t/${await token(shared, 'space-b/site')}/space-b/site/`, {}, s.env)
    expect(res.status).toBe(403)
    expectNoByteWork(s)
  })

  test("token minted for A used on B's URL → 403 with ZERO D1 statements (scope check first)", async () => {
    const s = setup()
    const { ownerA } = await twoSpaces(s)
    const tokenForA = await token(ownerA, 'space-a/site')
    s.db.resetCounters()
    s.recorder.resetCounters()
    const res = await s.app.request(`/_t/${tokenForA}/space-b/site/`, {}, s.env)
    expect(res.status).toBe(403)
    expect(s.db.counters.batches).toBe(0)
    expect(s.db.counters.loose).toBe(0)
    expect(s.db.counters.batchStmts).toBe(0)
    expectNoByteWork(s)
  })
})

// ---------------------------------------------------------------------------------------------
// T1.3 [pin] denial matrix on isolated fixtures. EVERY denial performs zero R2 ops and zero
// cache ops — authorization is decided purely in D1, bytes are never touched.
// ---------------------------------------------------------------------------------------------
describe('T1.3 denial matrix — no R2/cache work on any denial (pin)', () => {
  async function privateSite(s: Setup, o: { status?: 'active' | 'archived' } = {}) {
    const owner = await seedUser(s.db)
    const sp = await seedSpace(s.db, { createdBy: owner, slug: 'sp' })
    await seedMember(s.db, sp, owner)
    const siteId = await seedSite(s.db, {
      spaceId: sp,
      ownerId: owner,
      slug: 'site',
      visibility: 'private',
      status: o.status ?? 'active',
    })
    await seedFile(s.db, s.r2, siteId, { path: 'index.html', text: '<p>secret</p>' })
    return { owner, sp, siteId }
  }

  test('authed outsider on a private site → 403', async () => {
    const s = setup()
    await privateSite(s)
    const outsider = await seedUser(s.db)
    const res = await s.app.request(`/_t/${await token(outsider, 'sp/site')}/sp/site/`, {}, s.env)
    expect(res.status).toBe(403)
    expectNoByteWork(s)
  })

  test('archived site, owner → 410', async () => {
    const s = setup()
    const { owner } = await privateSite(s, { status: 'archived' })
    const res = await s.app.request(`/_t/${await token(owner, 'sp/site')}/sp/site/`, {}, s.env)
    expect(res.status).toBe(410)
    expectNoByteWork(s)
  })

  test('archived site, superadmin → 200 (archive exemption lives in checkAccess)', async () => {
    const s = setup()
    await privateSite(s, { status: 'archived' })
    const admin = await seedUser(s.db, { role: 'superadmin' })
    const res = await s.app.request(`/_t/${await token(admin, 'sp/site')}/sp/site/`, {}, s.env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>secret</p>')
  })

  test('untokened request → 403 (no anonymous tier), zero R2/cache', async () => {
    const s = setup()
    await privateSite(s)
    const res = await s.app.request('/sp/site/', {}, s.env)
    expect(res.status).toBe(403)
    expectNoByteWork(s)
  })

  test('token bound to a deleted/never-existing user → 403, zero R2/cache', async () => {
    const s = setup()
    await privateSite(s)
    const res = await s.app.request(`/_t/${await token('ghost-user', 'sp/site')}/sp/site/`, {}, s.env)
    expect(res.status).toBe(403)
    expectNoByteWork(s)
  })

  test('missing site → 404 with cache-control: no-store, zero R2/cache', async () => {
    const s = setup()
    const u = await seedUser(s.db)
    const res = await s.app.request(`/_t/${await token(u, 'no/where')}/no/where/`, {}, s.env)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expectNoByteWork(s)
  })
})

// ---------------------------------------------------------------------------------------------
// T1.1 [red pre-S1] the whole auth + file resolution is ONE D1 batch, issued BEFORE any R2 op.
// A .css asset is used so trackView (HTML/markdown only) adds no write to muddy the counts.
// ---------------------------------------------------------------------------------------------
describe('T1.1 happy path = exactly one D1 round trip', () => {
  test('.css asset: 1 batch, 0 loose statements, exact arity, batch strictly before first R2 op', async () => {
    const s = setup()
    const { token: t } = await teamSite(s, [
      { path: 'index.html', text: '<p>hi</p>' },
      { path: 'style.css', text: 'body{margin:0}', mimeType: 'text/css' },
    ])
    const res = await s.app.request(`/_t/${t}/sp/site/style.css`, {}, s.env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('body{margin:0}')
    expect(s.db.counters.batches).toBe(1)
    expect(s.db.counters.loose).toBe(0)
    expect(s.db.counters.batchStmts).toBe(SERVE_BATCH_ARITY)
    const timeline = s.recorder.timeline
    const batchAt = timeline.indexOf('d1:batch')
    const firstR2 = timeline.findIndex((e) => e.startsWith('r2:'))
    expect(batchAt).toBeGreaterThanOrEqual(0)
    expect(firstR2).toBeGreaterThan(batchAt)
  })
})

// ---------------------------------------------------------------------------------------------
// T1.4 live transitions on the SAME minted token: the batch reads LIVE state, so a revoke /
// removal / delete / archive between two hits flips 200 → 4xx/410 with no R2 work on the denial.
// ---------------------------------------------------------------------------------------------
describe('T1.4 live transitions on the same token', () => {
  async function expectFlip(s: Setup, t: string, mutate: () => Promise<unknown>, deniedStatus: number) {
    const first = await s.app.request(`/_t/${t}/sp/site/index.html`, {}, s.env)
    expect(first.status).toBe(200)
    await mutate()
    const r2Before = r2OpsTotal(s.r2)
    const second = await s.app.request(`/_t/${t}/sp/site/index.html`, {}, s.env)
    expect(second.status).toBe(deniedStatus)
    expect(r2OpsTotal(s.r2)).toBe(r2Before) // zero R2 ops on the denied hit
  }

  test('200 → revoke direct share → 403', async () => {
    const s = setup()
    const owner = await seedUser(s.db)
    const viewer = await seedUser(s.db)
    const sp = await seedSpace(s.db, { createdBy: owner, slug: 'sp' })
    const siteId = await seedSite(s.db, { spaceId: sp, ownerId: owner, slug: 'site', visibility: 'private' })
    await seedUserShare(s.db, siteId, viewer)
    await seedFile(s.db, s.r2, siteId, { path: 'index.html', text: '<p>x</p>' })
    const t = await token(viewer, 'sp/site')
    await expectFlip(
      s,
      t,
      () =>
        s.db
          .delete(siteUserShares)
          .where(and(eq(siteUserShares.siteId, siteId), eq(siteUserShares.userId, viewer))),
      403,
    )
  })

  test('200 → remove membership (members-tier visibility) → 403', async () => {
    const s = setup()
    const owner = await seedUser(s.db)
    const viewer = await seedUser(s.db)
    const sp = await seedSpace(s.db, { createdBy: owner, slug: 'sp' })
    await seedMember(s.db, sp, owner)
    await seedMember(s.db, sp, viewer)
    const siteId = await seedSite(s.db, { spaceId: sp, ownerId: owner, slug: 'site', visibility: 'members' })
    await seedFile(s.db, s.r2, siteId, { path: 'index.html', text: '<p>x</p>' })
    const t = await token(viewer, 'sp/site')
    await expectFlip(
      s,
      t,
      () => s.db.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, sp), eq(spaceMembers.userId, viewer))),
      403,
    )
  })

  test('200 → delete user row → 403', async () => {
    const s = setup()
    const { viewer, token: t } = await teamSite(s, [{ path: 'index.html', text: '<p>x</p>' }])
    await expectFlip(s, t, () => s.db.delete(users).where(eq(users.id, viewer)), 403)
  })

  test('200 → archive site → 410', async () => {
    const s = setup()
    const { siteId, token: t } = await teamSite(s, [{ path: 'index.html', text: '<p>x</p>' }])
    await expectFlip(s, t, () => s.db.update(sites).set({ status: 'archived' }).where(eq(sites.id, siteId)), 410)
  })
})

// ---------------------------------------------------------------------------------------------
// T1.2 [guard] the dir-listing fallback stays OUT of the batch: with an index.html present the
// batch alone resolves everything; only an index MISS takes one extra loose select (and still
// renders today's listing).
// ---------------------------------------------------------------------------------------------
describe('T1.2 dir-listing fallback stays out of the batch', () => {
  test('index.html EXISTS: exact batch arity, no all-files statement anywhere', async () => {
    const s = setup()
    const { token: t } = await teamSite(s, [
      { path: 'index.html', text: '<p>home</p>' },
      { path: 'other.html', text: '<p>other</p>' },
    ])
    const res = await s.app.request(`/_t/${t}/sp/site/`, {}, s.env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>home</p>')
    expect(s.db.counters.batches).toBe(1)
    expect(s.db.counters.batchStmts).toBe(SERVE_BATCH_ARITY)
    // index.html is a page load → exactly ONE loose statement, and it's the view-event insert.
    expect(s.db.counters.loose).toBe(1)
    expect(s.db.counters.insert).toBe(1)
  })

  test('no index.html: ONE extra loose select after the batch, listing still renders', async () => {
    const s = setup()
    const { token: t } = await teamSite(s, [
      { path: 'a.html', text: '<p>a</p>' },
      { path: 'b.html', text: '<p>b</p>' },
    ])
    const res = await s.app.request(`/_t/${t}/sp/site/`, {}, s.env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('a.html')
    expect(body).toContain('b.html')
    expect(s.db.counters.batches).toBe(1)
    expect(s.db.counters.batchStmts).toBe(SERVE_BATCH_ARITY)
    expect(s.db.counters.loose).toBe(1) // the all-files fallback select — nothing else
    expect(s.db.counters.insert).toBe(0) // a listing is not a page view
  })
})

// ---------------------------------------------------------------------------------------------
// T1.6 [module spec] accessFactsBySlugs returns assembled facts matching hand-seeded
// expectations (NOT compared against authorizeViewerById — no shared-oracle tautology).
// ---------------------------------------------------------------------------------------------
describe('T1.6 accessFactsBySlugs assembles hand-seeded facts', () => {
  async function base(s: Setup, visibility: 'private' | 'members' | 'team' = 'private') {
    const owner = await seedUser(s.db)
    const viewer = await seedUser(s.db, { email: 'viewer@example.com', name: 'Viewer' })
    const sp = await seedSpace(s.db, { createdBy: owner, slug: 'sp' })
    await seedMember(s.db, sp, owner)
    const siteId = await seedSite(s.db, { spaceId: sp, ownerId: owner, slug: 'site', visibility })
    return { owner, viewer, sp, siteId }
  }

  test('revoked direct share → directRole null, groupShared false, site+user still resolved', async () => {
    const s = setup()
    const { viewer, siteId } = await base(s)
    await seedUserShare(s.db, siteId, viewer)
    await s.db
      .delete(siteUserShares)
      .where(and(eq(siteUserShares.siteId, siteId), eq(siteUserShares.userId, viewer)))
    const facts = await accessFactsBySlugs(s.db, 'sp', 'site', viewer)
    expect(facts.site?.id).toBe(siteId)
    expect(facts.user).toEqual({ id: viewer, email: 'viewer@example.com', name: 'Viewer', role: 'member' })
    expect(facts.isMember).toBe(false)
    expect(facts.directRole).toBeNull()
    expect(facts.groupShared).toBe(false)
  })

  test('removed membership → isMember false', async () => {
    const s = setup()
    const { viewer, sp } = await base(s, 'members')
    await seedMember(s.db, sp, viewer)
    await s.db.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, sp), eq(spaceMembers.userId, viewer)))
    const facts = await accessFactsBySlugs(s.db, 'sp', 'site', viewer)
    expect(facts.site).not.toBeNull()
    expect(facts.isMember).toBe(false)
  })

  test('deleted user → user null, every user-derived fact false/null', async () => {
    const s = setup()
    await base(s)
    const facts = await accessFactsBySlugs(s.db, 'sp', 'site', 'ghost-user')
    expect(facts.site).not.toBeNull()
    expect(facts.user).toBeNull()
    expect(facts.isMember).toBe(false)
    expect(facts.directRole).toBeNull()
    expect(facts.groupShared).toBe(false)
  })

  test('missing site → site null; the user row (id-keyed) still resolves', async () => {
    const s = setup()
    const { viewer } = await base(s)
    const facts = await accessFactsBySlugs(s.db, 'sp', 'no-such-site', viewer)
    expect(facts.site).toBeNull()
    expect(facts.user?.id).toBe(viewer)
    expect(facts.isMember).toBe(false)
    expect(facts.directRole).toBeNull()
    expect(facts.groupShared).toBe(false)
  })

  test("direct editor share → directRole 'editor'", async () => {
    const s = setup()
    const { viewer, siteId } = await base(s)
    await seedUserShare(s.db, siteId, viewer, 'editor')
    const facts = await accessFactsBySlugs(s.db, 'sp', 'site', viewer)
    expect(facts.directRole).toBe('editor')
    expect(facts.groupShared).toBe(false)
  })

  test('group-only share → groupShared true, directRole stays null', async () => {
    const s = setup()
    const { owner, viewer, siteId } = await base(s)
    const group = await seedSpace(s.db, { createdBy: owner, slug: 'group' })
    await seedMember(s.db, group, viewer)
    await seedGroupShare(s.db, siteId, group)
    const facts = await accessFactsBySlugs(s.db, 'sp', 'site', viewer)
    expect(facts.groupShared).toBe(true)
    expect(facts.directRole).toBeNull()
    expect(facts.isMember).toBe(false) // group membership is NOT membership in the site's space
  })
})

// ---------------------------------------------------------------------------------------------
// T1.7 [char] fault injection + branch parity: garbage never rejects the batch, and the
// raw/annotate/markdown branches all run off the SINGLE batch (no branch re-queries).
// ---------------------------------------------------------------------------------------------
describe('T1.7 fault injection and branch parity', () => {
  test('garbage slugs/user → batch resolves to all-empty facts, never throws', async () => {
    const s = setup()
    const facts = await accessFactsBySlugs(s.db, "no'such--space", '../weird slug%', 'ghost')
    expect(facts).toEqual({ site: null, user: null, isMember: false, directRole: null, groupShared: false })
  })

  test('garbage path on a real site → 404, batch intact', async () => {
    const s = setup()
    const { token: t } = await teamSite(s, [{ path: 'index.html', text: '<p>x</p>' }])
    const res = await s.app.request(`/_t/${t}/sp/site/..%2f..%2f%00weird`, {}, s.env)
    expect(res.status).toBe(404)
    expect(s.db.counters.batches).toBe(1)
  })

  test('raw=1 vs annotate vs markdown: identical D1 read count (1 batch, exact arity, no re-queries)', async () => {
    const s = setup()
    const { token: t } = await teamSite(s, [
      { path: 'index.html', text: '<html><head></head><body><p>x</p></body></html>' },
      { path: 'doc.md', text: '# Title', mimeType: 'text/markdown' },
    ])
    const hits = [
      { url: `/_t/${t}/sp/site/doc.md?raw=1`, contains: '# Title' },
      { url: `/_t/${t}/sp/site/index.html?glance_annotate=1`, contains: 'window.__GLANCE__' },
      { url: `/_t/${t}/sp/site/doc.md`, contains: '<h1>Title</h1>' },
    ]
    for (const hit of hits) {
      s.db.resetCounters()
      const res = await s.app.request(hit.url, {}, s.env)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain(hit.contains)
      // Identical read shape on every branch: ONE batch at the exact arity, and every loose
      // statement (if any) is the view-event insert — never a re-query.
      expect(s.db.counters.batches).toBe(1)
      expect(s.db.counters.batchStmts).toBe(SERVE_BATCH_ARITY)
      expect(s.db.counters.loose).toBe(s.db.counters.insert)
    }
  })
})
