import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { comments, events, files, purgedEventCounts, sites, users } from '../db/schema'

// Usage-analytics rollups for the admin dashboard. Everything is derived from existing state
// (users/sites/files/comments) plus the append-only `events` stream, so counts are exact and
// joinable. Superadmin-only surface (see routes/admin.ts) — read-only aggregation.
//
// NO CLI STATS HERE, deliberately. `events` type 'cli' rows are still WRITTEN (middleware/
// analytics.ts) — /api/auth/me's `hasUsedCli` probe reads one — but the two CLI rollups this file
// used to expose (an all-time `count(*)` and a 30-day per-day series) measured at 7,329 + 14,657
// D1 rows read, i.e. 40% of the entire dashboard's cost, for two figures nobody acted on. The CLI
// is chattier than the site itself (7.3k cli events vs 3k page views), so any all-table aggregate
// over those rows is the single most expensive thing here. Re-adding either one means paying that
// again — do it off a rollup table, not a live scan.

export interface StatsTotals {
  users: number
  sites: number
  files: number
  storageBytes: number
  comments: number
  views: number
  uniqueViewers: number
}

export interface DailyPoint {
  date: string // YYYY-MM-DD (UTC)
  signups: number
  sites: number
  views: number
  comments: number
}

export interface TopSite {
  siteId: string | null
  siteLabel: string | null
  views: number
}

/** The rolling-window half of `Stats` — everything bounded by WINDOW_DAYS. Cached separately from
 *  the all-time totals, so the two refresh on their own clocks (see the cache front below). */
export interface WindowStats {
  activeViewers30d: number
  series: DailyPoint[] // one zero-filled row per day, oldest → newest
  topSites: TopSite[]
  windowDays: number
}

export interface Stats extends WindowStats {
  totals: StatsTotals
}

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_DAYS = 30

/** YYYY-MM-DD (UTC) for a date — matches substr(createdAt, 1, 10) on our ISO-8601 timestamps. */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

/** `count(*)` helper: unwrap drizzle's row shape to a plain number. */
async function scalarCount(query: Promise<{ n: number }[]>): Promise<number> {
  const rows = await query
  return Number(rows[0]?.n ?? 0)
}

/**
 * The ALL-TIME half: headline totals over the full table. Every one of these is a scan whose cost
 * grows with history forever (`count(*)`/`count(distinct)` over every `view` row ever, `count(*)`
 * and `sum(size)` over every file) — this is the unbounded term, and the reason the cache below
 * gives it its own long-lived key. Nothing here moves fast enough to be worth a live scan.
 */
export async function computeTotals(db: DrizzleD1Database): Promise<StatsTotals> {
  const [u, s, f, storage, cm, vw, uv, purgedVw] = await Promise.all([
    scalarCount(db.select({ n: count() }).from(users)),
    scalarCount(db.select({ n: count() }).from(sites)),
    scalarCount(db.select({ n: count() }).from(files)),
    db
      .select({ n: sql<number>`coalesce(sum(${files.size}), 0)` })
      .from(files)
      .then((r) => Number(r[0]?.n ?? 0)),
    scalarCount(db.select({ n: count() }).from(comments).where(isNull(comments.deletedAt))),
    scalarCount(db.select({ n: count() }).from(events).where(eq(events.type, 'view'))),
    // NOT all-time after the retention purge (lib/retention.ts) lands: rows older than
    // EVENTS_RETENTION_DAYS are gone, so this is "distinct viewers within the retention window",
    // not distinct-ever. Unlike `views` (a plain count(*), see purgedEventCounts below), a
    // count(distinct) can't be reconstructed from a running total once the underlying rows are
    // deleted, so it is left as-is rather than faked.
    db
      .select({ n: sql<number>`count(distinct ${events.userId})` })
      .from(events)
      .where(eq(events.type, 'view'))
      .then((r) => Number(r[0]?.n ?? 0)),
    // Rows the purge already deleted, folded back in so `views` stays a true all-time count.
    db
      .select({ n: purgedEventCounts.count })
      .from(purgedEventCounts)
      .where(eq(purgedEventCounts.type, 'view'))
      .then((r) => Number(r[0]?.n ?? 0)),
  ])
  return { users: u, sites: s, files: f, storageBytes: storage, comments: cm, views: vw + purgedVw, uniqueViewers: uv }
}

/**
 * The ROLLING-WINDOW half: everything bounded by the 30-day window, so its cost is flat as the
 * database grows (a busier month costs more, a longer-lived deploy does not). Refreshed far more
 * often than the totals — it is the half that actually changes day to day.
 */
export async function computeWindow(db: DrizzleD1Database, now: Date = new Date()): Promise<WindowStats> {
  // Inclusive 30-day window: today back through 29 days ago, from midnight UTC of the first day.
  const startDay = new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS)
  const sinceTs = `${dayKey(startDay)}T00:00:00.000Z`
  const day = sql<string>`substr(${events.createdAt}, 1, 10)`
  const uDay = sql<string>`substr(${users.createdAt}, 1, 10)`
  const sDay = sql<string>`substr(${sites.createdAt}, 1, 10)`
  const cDay = sql<string>`substr(${comments.createdAt}, 1, 10)`

  const [activeViewers30d, signupsByDay, sitesByDay, viewsByDay, commentsByDay, topSites] = await Promise.all([
    // Distinct viewers active in the window.
    db
      .select({ n: sql<number>`count(distinct ${events.userId})` })
      .from(events)
      .where(and(eq(events.type, 'view'), gte(events.createdAt, sinceTs)))
      .then((r) => Number(r[0]?.n ?? 0)),
    // Per-day series (sparse; zero-filled below).
    db.select({ date: uDay, n: count() }).from(users).where(gte(users.createdAt, sinceTs)).groupBy(uDay),
    db.select({ date: sDay, n: count() }).from(sites).where(gte(sites.createdAt, sinceTs)).groupBy(sDay),
    db
      .select({ date: day, n: count() })
      .from(events)
      .where(and(eq(events.type, 'view'), gte(events.createdAt, sinceTs)))
      .groupBy(day),
    db
      .select({ date: cDay, n: count() })
      .from(comments)
      .where(and(isNull(comments.deletedAt), gte(comments.createdAt, sinceTs)))
      .groupBy(cDay),
    // Most-viewed sites in the window. siteLabel is stable per site, so max() picks it safely.
    db
      .select({
        siteId: events.siteId,
        siteLabel: sql<string>`max(${events.siteLabel})`,
        views: count(),
      })
      .from(events)
      .where(and(eq(events.type, 'view'), gte(events.createdAt, sinceTs)))
      .groupBy(events.siteId)
      .orderBy(desc(count()))
      .limit(10),
  ])

  const series = buildSeries(now, {
    signups: signupsByDay,
    sites: sitesByDay,
    views: viewsByDay,
    comments: commentsByDay,
  })

  return {
    activeViewers30d,
    series,
    topSites: topSites.map((t) => ({ siteId: t.siteId, siteLabel: t.siteLabel ?? null, views: Number(t.views) })),
    windowDays: WINDOW_DAYS,
  }
}

// --- Cache front for the admin dashboard ----------------------------------------------------
//
// A full recompute is 13 aggregates and most of them are unavoidable FULL SCANS (all-time counts,
// `count(distinct userId)`, `sum(files.size)`, the 30-day group-bys) — ~10k D1 rows read per call
// (measured via `wrangler d1 insights --time-period 30d`, 2026-08-03) against a database whose
// largest table is ~10k rows. The admin page is a React Router loader, so every navigation, back
// button, and tab switch re-ran the whole thing: 770 recomputes in 30 days, 7.4M rows read, 57%
// of the account's ENTIRE D1 rows-read budget. Nothing here is real-time by nature (the window is
// per-DAY buckets), so a shared TTL costs nothing in usefulness.
//
// SPLIT BY HOW FAST THE NUMBERS ACTUALLY MOVE, not one TTL over the lot. The two halves have
// different cost curves, so one shared expiry priced them wrong in both directions:
//   • totals (all-time) — cost grows with history FOREVER, and "total users ever" does not move
//     minute to minute. Long TTL. This is the half that would otherwise get slowly worse for good.
//   • window (rolling 30d) — cost is flat as the DB grows (bounded by the window), and it IS what
//     changes day to day. Short TTL.
// Recomputing the unbounded half on the bounded half's clock was the actual waste.
//
// STALE-WHILE-REVALIDATE on top: past the soft TTL a half is served STALE and recomputed off the
// critical path via `defer`, so no visitor ever waits on a recount and a cold-ish cache never
// stampedes into a synchronous 13-aggregate scan. The KV entry's own `expirationTtl` is the soft
// TTL × STATS_STALE_FACTOR — the hard floor past which stale is no longer worth serving and the
// next caller pays for a fresh compute.

// SUBSTRATE — KV, deliberately NOT the Workers Cache API. `caches.default` is only documented as
// functional for Workers on CUSTOM DOMAINS (and Pages on `*.pages.dev`); `*.workers.dev` is
// conspicuously absent from that list, and cache ops there are widely reported as silent no-ops —
// `put` resolves, `match` never hits, and the fix would look applied while changing nothing. This
// deploy runs on `glance.<subdomain>.workers.dev`, so the Cache API is not a safe bet here. KV is
// unambiguously functional on workers.dev, and its TTL is a server-side `expirationTtl` rather
// than a Cache-Control the runtime may or may not honour. It is also GLOBAL, not per-colo, so one
// compute serves every region instead of one per colo.

/** KV keys for the two halves of the rollup. Namespaced under `stats:` alongside the namespace's
 *  `session:`/`cli:` keys. VERSIONED: the cached value is a serialized payload, so any change to
 *  its shape must bump `v<n>` — otherwise the deploy keeps serving the previous shape until the
 *  TTL lapses and the dashboard renders `undefined` for the fields that moved. v3 is where the
 *  single `stats:admin:v2` entry became these two (and gained the `{at,v}` envelope); the old key
 *  is simply abandoned and expires on its own. */
export const STATS_CACHE_KEY = 'stats:admin:window:v3'
export const STATS_TOTALS_CACHE_KEY = 'stats:admin:totals:v3'

/** Soft TTL for the rolling-window half, in seconds. Past this it is served stale and refreshed
 *  in the background. Bounded cost, and it is the half that genuinely moves — 1 hour. */
export const STATS_CACHE_SECONDS = 3600

/** Soft TTL for the all-time totals, in seconds. Unbounded cost, near-static value — 24 hours.
 *  This single number is what stops the dashboard's cost growing with history forever. */
export const STATS_TOTALS_CACHE_SECONDS = 86_400

/** How far past its soft TTL an entry stays servable-as-stale. The KV `expirationTtl` is
 *  soft × this, so a half that nobody refreshes eventually falls out and is recomputed fresh. */
export const STATS_STALE_FACTOR = 4

/** Minimal KV surface this layer uses — the real KVNamespace binding satisfies it structurally,
 *  as does the harness mock. */
export type StatsCacheKv = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** Cache envelope. The stamp is what makes stale-while-revalidate possible at all: KV can only
 *  tell us an entry EXISTS, never how old it is, so freshness has to ride inside the value. */
type Entry<T> = { at: number; v: T }

/** Read + validate one entry. Anything unreadable is a MISS, never an error — KV throwing, torn
 *  JSON, or a pre-v3 payload that has no envelope. A broken cache must not break the dashboard. */
async function readEntry<T>(kv: StatsCacheKv, key: string): Promise<Entry<T> | null> {
  try {
    const raw = await kv.get(key)
    if (!raw) return null
    const entry = JSON.parse(raw) as Entry<T>
    return typeof entry?.at === 'number' && entry.v != null ? entry : null
  } catch {
    return null
  }
}

/**
 * One cached half. Fresh hit → serve it, ZERO D1 statements. Stale hit → serve the STALE value and
 * recompute off the critical path, so the caller never waits on a recount. Miss → compute inline
 * (nothing to serve) and warm the entry via `defer`.
 *
 * A `null` kv degrades to computing every call — a deploy with no KV binding still works, it just
 * pays full price, exactly as before this layer existed.
 */
async function cachedHalf<T>(
  kv: StatsCacheKv | null,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  defer: (p: Promise<unknown>) => Promise<void>,
  now: Date,
): Promise<T> {
  if (!kv) return compute()

  const write = (v: T): Promise<void> =>
    kv.put(key, JSON.stringify({ at: now.getTime(), v } satisfies Entry<T>), {
      expirationTtl: ttlSeconds * STATS_STALE_FACTOR,
    })

  const hit = await readEntry<T>(kv, key)
  if (hit && now.getTime() - hit.at < ttlSeconds * 1000) return hit.v
  if (hit) {
    // Stale: hand back the old numbers now, let the recount land behind the response. A failed
    // refresh is silent — the entry just stays stale until someone else's request retries it.
    await defer(
      compute()
        .then(write)
        .catch(() => {}),
    )
    return hit.v
  }
  const value = await compute()
  await defer(write(value).catch(() => {}))
  return value
}

/** The two halves fronted by KV, each on its own clock, recombined into the `Stats` shape the
 *  dashboard already consumes. NOT an authorization boundary: this returns the whole account
 *  rollup to whoever calls it, so it must stay behind the superadmin gate its only caller
 *  (routes/admin.ts) sits under. */
export async function cachedStats(
  kv: StatsCacheKv | null,
  db: DrizzleD1Database,
  defer: (p: Promise<unknown>) => Promise<void>,
  now: Date = new Date(),
): Promise<Stats> {
  const [totals, window] = await Promise.all([
    cachedHalf(kv, STATS_TOTALS_CACHE_KEY, STATS_TOTALS_CACHE_SECONDS, () => computeTotals(db), defer, now),
    cachedHalf(kv, STATS_CACHE_KEY, STATS_CACHE_SECONDS, () => computeWindow(db, now), defer, now),
  ])
  return { totals, ...window }
}

type DayRows = { date: string; n: number }[]

/** Zero-fill the window: one row per day (oldest → newest), merging each metric's sparse counts. */
function buildSeries(now: Date, metrics: Record<'signups' | 'sites' | 'views' | 'comments', DayRows>): DailyPoint[] {
  const index: Record<string, Map<string, number>> = {}
  for (const [key, rows] of Object.entries(metrics)) {
    index[key] = new Map(rows.map((r) => [r.date, Number(r.n)]))
  }
  const out: DailyPoint[] = []
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = dayKey(new Date(now.getTime() - i * DAY_MS))
    out.push({
      date,
      signups: index.signups.get(date) ?? 0,
      sites: index.sites.get(date) ?? 0,
      views: index.views.get(date) ?? 0,
      comments: index.comments.get(date) ?? 0,
    })
  }
  return out
}
