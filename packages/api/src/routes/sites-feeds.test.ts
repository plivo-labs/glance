import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { seedFile, seedMember, seedSite, seedSpace, seedUserShare } from '../test/harness'
import { APP_URL, at, auth, makeRouteApp, mintUser, postAuthRequests, type RouteApp } from '../test/route-fixtures'
import type { AppEnv } from '../types'

// S5b — GET /api/sites/mine and GET /api/sites/team fold the pure-audio badge INTO the site
// select (one post-auth D1 request each; today a serial allAudioSiteIds follows the site rows).
// T5.4/T5.5 pin today's semantics FIRST so the fold can't drift: one row per site regardless of
// file count, /team's LIMIT 50 applies to SITES (a joined-files rewrite could eat it), the
// audio-flag truth table, /mine's no-archived-filter quirk, and the sharedSiteIds Set surface
// the search + spaces callers keep using. T5.3 is the request-budget spec the fold turns green.

/** App + owner-run 'acme' space, with a signed-in Bearer token for `owner`. */
async function setup() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  await mintUser(db, kv, 'owner', { email: 'owner@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  return ctx
}

const getJson = <T>(app: Hono<AppEnv>, env: AppEnv['Bindings'], path: string, id: string): Promise<T> =>
  app.request(path, { headers: auth(id) }, env).then((r) => r.json() as Promise<T>)

type MineRow = { id: string; siteSlug: string; status: string; audio: boolean }
type TeamRow = { id: string; audio: boolean }

describe('feeds — audio badge pins (S5b T5.4)', () => {
  test('pin: /mine — a 30-file pure-audio site is exactly ONE row, full payload unchanged', async () => {
    const { app, env, db } = await setup()
    await seedSite(db, { id: 'voice', spaceId: 'acme', ownerId: 'owner', slug: 'voice', visibility: 'private', createdAt: at(2) })
    for (let i = 0; i < 30; i++) await seedFile(db, null, 'voice', { path: `take-${i}.mp3`, text: 'b' })
    await seedSite(db, { id: 'doc', spaceId: 'acme', ownerId: 'owner', slug: 'doc', createdAt: at(1) })
    await seedFile(db, null, 'doc', { path: 'index.html', text: 'b' })

    // Hand-coded: one row PER SITE (30 files must not explode the feed), newest first.
    expect(await getJson(app, env, '/api/sites/mine', 'owner')).toEqual([
      { id: 'voice', spaceSlug: 'acme', siteSlug: 'voice', title: null, visibility: 'private', status: 'active', audio: true, url: `${APP_URL}/acme/voice`, createdAt: at(2) },
      { id: 'doc', spaceSlug: 'acme', siteSlug: 'doc', title: null, visibility: 'team', status: 'active', audio: false, url: `${APP_URL}/acme/doc`, createdAt: at(1) },
    ])
  })

  test('pin: /team — 51 team sites, newest with 30 files → the 50 DISTINCT newest (LIMIT on sites, not joined rows)', async () => {
    const { app, env, db } = await setup()
    const n = 51
    for (let i = 1; i <= n; i++) {
      await seedSite(db, { id: `s${i}`, spaceId: 'acme', ownerId: 'owner', slug: `s${i}`, createdAt: at(i) })
    }
    for (let i = 0; i < 30; i++) await seedFile(db, null, `s${n}`, { path: `take-${i}.mp3`, text: 'b' })

    const rows = await getJson<TeamRow[]>(app, env, '/api/sites/team', 'owner')
    expect(rows).toHaveLength(50)
    expect(new Set(rows.map((r) => r.id)).size).toBe(50) // distinct — no join duplication
    // Exactly the 50 newest, newest first: s51..s2 (s1 falls off the cap).
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_, k) => `s${n - k}`))
    // The 30-file site is pure audio; the file-less rest are not. Full payload on the head row.
    expect(rows[0]).toEqual({
      id: 's51', spaceSlug: 'acme', siteSlug: 's51', title: null, visibility: 'team', status: 'active',
      audio: true, url: `${APP_URL}/acme/s51`, createdAt: at(51), uploaderName: null, uploaderEmail: 'owner@e.com',
    })
    expect(rows.slice(1).every((r) => r.audio === false)).toBe(true)
  })

  test('pin: audio truth table — all-audio true; audio+non-audio false; zero-file false', async () => {
    const { app, env, db } = await setup()
    await seedSite(db, { id: 'pure', spaceId: 'acme', ownerId: 'owner', slug: 'pure', createdAt: at(3) })
    await seedFile(db, null, 'pure', { path: 'a.mp3', text: 'b' })
    await seedFile(db, null, 'pure', { path: 'b.wav', text: 'b' })
    await seedSite(db, { id: 'mixed', spaceId: 'acme', ownerId: 'owner', slug: 'mixed', createdAt: at(2) })
    await seedFile(db, null, 'mixed', { path: 'song.mp3', text: 'b' })
    await seedFile(db, null, 'mixed', { path: 'cover.png', text: 'b' })
    await seedSite(db, { id: 'empty', spaceId: 'acme', ownerId: 'owner', slug: 'empty', createdAt: at(1) })

    const flags = (rows: MineRow[]) => rows.map((r) => ({ id: r.id, audio: r.audio }))
    const expected = [
      { id: 'pure', audio: true },
      { id: 'mixed', audio: false }, // ALL files must be audio
      { id: 'empty', audio: false }, // at least one file required
    ]
    expect(flags(await getJson(app, env, '/api/sites/mine', 'owner'))).toEqual(expected)
    expect(flags(await getJson(app, env, '/api/sites/team', 'owner'))).toEqual(expected)
  })
})

describe('feeds — behavior pins (S5b T5.5)', () => {
  test('pin: /mine still lists an archived site (no status filter today)', async () => {
    const { app, env, db } = await setup()
    await seedSite(db, { id: 'gone', spaceId: 'acme', ownerId: 'owner', slug: 'gone', status: 'archived', createdAt: at(2) })
    await seedSite(db, { id: 'live', spaceId: 'acme', ownerId: 'owner', slug: 'live', createdAt: at(1) })

    const rows = await getJson<MineRow[]>(app, env, '/api/sites/mine', 'owner')
    expect(rows.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: 'gone', status: 'archived' },
      { id: 'live', status: 'active' },
    ])
  })

  // sharedSiteIds stays (only /mine //team stop using the audio helper's sibling) — smoke its two
  // remaining route callers so the Set surface can't silently break.
  async function seedSharedPrivate(db: RouteApp['db'], kv: RouteApp['kv']) {
    await mintUser(db, kv, 'me', { email: 'me@e.com' })
    // 'me' is NOT a member of acme: only the direct share can admit them.
    await seedSite(db, { id: 'hush', spaceId: 'acme', ownerId: 'owner', slug: 'hush', visibility: 'private', createdAt: at(2) })
    await seedUserShare(db, 'hush', 'me', 'viewer')
    await seedSite(db, { id: 'walled', spaceId: 'acme', ownerId: 'owner', slug: 'walled', visibility: 'private', createdAt: at(1) })
  }

  test('smoke: sharedSiteIds still feeds search — a direct-share private site is findable', async () => {
    const { app, env, db, kv } = await setup()
    await seedSharedPrivate(db, kv)
    const rows = await getJson<{ id: string }[]>(app, env, '/api/sites/search?q=hush', 'me')
    expect(rows.map((r) => r.id)).toEqual(['hush'])
    expect(await getJson(app, env, '/api/sites/search?q=walled', 'me')).toEqual([]) // unshared stays invisible
  })

  test('smoke: sharedSiteIds still feeds a space listing — non-member sees only the shared site', async () => {
    const { app, env, db, kv } = await setup()
    await seedSharedPrivate(db, kv)
    const rows = await getJson<{ id: string }[]>(app, env, '/api/spaces/acme/sites', 'me')
    expect(rows.map((r) => r.id)).toEqual(['hush'])
  })
})

describe('feeds — post-auth D1 request budget (S5b T5.3)', () => {
  async function seedBudget(db: RouteApp['db']) {
    await seedSite(db, { id: 'pure', spaceId: 'acme', ownerId: 'owner', slug: 'pure', createdAt: at(2) })
    await seedFile(db, null, 'pure', { path: 'a.mp3', text: 'b' })
    await seedSite(db, { id: 'mixed', spaceId: 'acme', ownerId: 'owner', slug: 'mixed', createdAt: at(1) })
    await seedFile(db, null, 'mixed', { path: 'song.mp3', text: 'b' })
    await seedFile(db, null, 'mixed', { path: 'index.html', text: 'b' })
  }

  test('perf: /mine costs exactly 1 post-auth D1 request (audio folded into the site select)', async () => {
    const { app, env, db } = await setup()
    await seedBudget(db)
    db.resetCounters()

    const rows = await getJson<MineRow[]>(app, env, '/api/sites/mine', 'owner')
    expect(rows.map((r) => ({ id: r.id, audio: r.audio }))).toEqual([
      { id: 'pure', audio: true },
      { id: 'mixed', audio: false },
    ])
    expect(postAuthRequests(db)).toBe(1)
    // Exact shape: auth's getUserById + ONE loose feed select, no batches.
    expect(db.counters).toMatchObject({ loose: 2, batches: 0 })
  })

  test('perf: /team costs exactly 1 post-auth D1 request (audio folded into the site select)', async () => {
    const { app, env, db } = await setup()
    await seedBudget(db)
    db.resetCounters()

    const rows = await getJson<TeamRow[]>(app, env, '/api/sites/team', 'owner')
    expect(rows.map((r) => ({ id: r.id, audio: r.audio }))).toEqual([
      { id: 'pure', audio: true },
      { id: 'mixed', audio: false },
    ])
    expect(postAuthRequests(db)).toBe(1)
    expect(db.counters).toMatchObject({ loose: 2, batches: 0 })
  })
})
