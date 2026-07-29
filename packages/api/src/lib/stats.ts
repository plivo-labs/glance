import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { comments, events, files, sites, users } from '../db/schema'

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

export interface Stats {
  totals: StatsTotals
  activeViewers30d: number
  series: DailyPoint[] // one zero-filled row per day, oldest → newest
  topSites: TopSite[]
  windowDays: number
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

export async function computeStats(db: DrizzleD1Database, now: Date = new Date()): Promise<Stats> {
  // Inclusive 30-day window: today back through 29 days ago, from midnight UTC of the first day.
  const startDay = new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS)
  const sinceTs = `${dayKey(startDay)}T00:00:00.000Z`
  const day = sql<string>`substr(${events.createdAt}, 1, 10)`
  const uDay = sql<string>`substr(${users.createdAt}, 1, 10)`
  const sDay = sql<string>`substr(${sites.createdAt}, 1, 10)`
  const cDay = sql<string>`substr(${comments.createdAt}, 1, 10)`

  const [totals, activeViewers30d, signupsByDay, sitesByDay, viewsByDay, commentsByDay, topSites] = await Promise.all([
    // Headline totals (all-time).
    (async (): Promise<StatsTotals> => {
      const [u, s, f, storage, cm, vw, uv] = await Promise.all([
        scalarCount(db.select({ n: count() }).from(users)),
        scalarCount(db.select({ n: count() }).from(sites)),
        scalarCount(db.select({ n: count() }).from(files)),
        db
          .select({ n: sql<number>`coalesce(sum(${files.size}), 0)` })
          .from(files)
          .then((r) => Number(r[0]?.n ?? 0)),
        scalarCount(db.select({ n: count() }).from(comments).where(isNull(comments.deletedAt))),
        scalarCount(db.select({ n: count() }).from(events).where(eq(events.type, 'view'))),
        db
          .select({ n: sql<number>`count(distinct ${events.userId})` })
          .from(events)
          .where(eq(events.type, 'view'))
          .then((r) => Number(r[0]?.n ?? 0)),
      ])
      return {
        users: u,
        sites: s,
        files: f,
        storageBytes: storage,
        comments: cm,
        views: vw,
        uniqueViewers: uv,
      }
    })(),
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
    totals,
    activeViewers30d,
    series,
    topSites: topSites.map((t) => ({ siteId: t.siteId, siteLabel: t.siteLabel ?? null, views: Number(t.views) })),
    windowDays: WINDOW_DAYS,
  }
}

// --- Cache front for the admin dashboard ----------------------------------------------------
//
// `computeStats` is 13 aggregates and most of them are unavoidable FULL SCANS (all-time counts,
// `count(distinct userId)`, `sum(files.size)`, the 30-day group-bys) — ~33k D1 rows read per call
// (measured per-aggregate against prod, 2026-07-29; was ~55k before the CLI rollups came out)
// against a database whose largest table is ~10k rows. The admin page is a React Router loader,
// so every navigation, back button, and tab switch re-ran the whole thing: measured at ~73% of
// the account's ENTIRE D1 rows-read budget. Nothing here is real-time by nature (the window is
// per-DAY buckets), so a short shared TTL costs nothing in usefulness.

// SUBSTRATE — KV, deliberately NOT the Workers Cache API. `caches.default` is only documented as
// functional for Workers on CUSTOM DOMAINS (and Pages on `*.pages.dev`); `*.workers.dev` is
// conspicuously absent from that list, and cache ops there are widely reported as silent no-ops —
// `put` resolves, `match` never hits, and the fix would look applied while changing nothing. This
// deploy runs on `glance.<subdomain>.workers.dev`, so the Cache API is not a safe bet here. KV is
// unambiguously functional on workers.dev, and its TTL is a server-side `expirationTtl` rather
// than a Cache-Control the runtime may or may not honour. It is also GLOBAL, not per-colo, so one
// compute serves every region instead of one per colo.

/** KV key for the single account-wide rollup entry. Namespaced under `stats:` alongside the
 *  namespace's `session:`/`cli:` keys. VERSIONED: the cached value is a serialized `Stats`, so any
 *  change to that shape must bump `v<n>` — otherwise the deploy keeps serving the previous shape
 *  until the TTL lapses and the dashboard renders `undefined` for the fields that moved. */
export const STATS_CACHE_KEY = 'stats:admin:v2'

/** Freshness window for the cached rollup, in seconds. */
export const STATS_CACHE_SECONDS = 300

/** Minimal KV surface this layer uses — the real KVNamespace binding satisfies it structurally,
 *  as does the harness mock. */
export type StatsCacheKv = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** `computeStats` fronted by KV. Hit → the stored JSON, ZERO D1 reads. Miss (or a KV that throws —
 *  a broken cache must never break the dashboard) → compute, then write the entry off the critical
 *  path via `defer`. NOT an authorization boundary: this returns the whole account rollup to whoever
 *  calls it, so it must stay behind the superadmin gate its only caller (routes/admin.ts) sits under.
 *  `kv` may be null, which degrades to computing every call — today's exact behaviour. */
export async function cachedStats(
  kv: StatsCacheKv | null,
  db: DrizzleD1Database,
  defer: (p: Promise<unknown>) => Promise<void>,
): Promise<Stats> {
  if (kv) {
    try {
      const hit = await kv.get(STATS_CACHE_KEY)
      if (hit) return JSON.parse(hit) as Stats
    } catch {
      // fall through and compute — an unreadable or malformed entry is a miss, never an error
    }
  }
  const stats = await computeStats(db)
  if (kv) {
    await defer(kv.put(STATS_CACHE_KEY, JSON.stringify(stats), { expirationTtl: STATS_CACHE_SECONDS }).catch(() => {}))
  }
  return stats
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
