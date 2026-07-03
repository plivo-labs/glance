import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { comments, events, files, sites, users } from '../db/schema'

// Usage-analytics rollups for the admin dashboard. Everything is derived from existing state
// (users/sites/files/comments) plus the append-only `events` stream (views + CLI), so counts are
// exact and joinable. Superadmin-only surface (see routes/admin.ts) — read-only aggregation.

export interface StatsTotals {
  users: number
  sites: number
  files: number
  storageBytes: number
  comments: number
  views: number
  cliInvocations: number
  uniqueViewers: number
}

export interface DailyPoint {
  date: string // YYYY-MM-DD (UTC)
  signups: number
  sites: number
  views: number
  comments: number
  cli: number
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

  const [totals, activeViewers30d, signupsByDay, sitesByDay, viewsByDay, commentsByDay, cliByDay, topSites] =
    await Promise.all([
      // Headline totals (all-time).
      (async (): Promise<StatsTotals> => {
        const [u, s, f, storage, cm, vw, cli, uv] = await Promise.all([
          scalarCount(db.select({ n: count() }).from(users)),
          scalarCount(db.select({ n: count() }).from(sites)),
          scalarCount(db.select({ n: count() }).from(files)),
          db
            .select({ n: sql<number>`coalesce(sum(${files.size}), 0)` })
            .from(files)
            .then((r) => Number(r[0]?.n ?? 0)),
          scalarCount(db.select({ n: count() }).from(comments).where(isNull(comments.deletedAt))),
          scalarCount(db.select({ n: count() }).from(events).where(eq(events.type, 'view'))),
          scalarCount(db.select({ n: count() }).from(events).where(eq(events.type, 'cli'))),
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
          cliInvocations: cli,
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
      db
        .select({ date: day, n: count() })
        .from(events)
        .where(and(eq(events.type, 'cli'), gte(events.createdAt, sinceTs)))
        .groupBy(day),
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
    cli: cliByDay,
  })

  return {
    totals,
    activeViewers30d,
    series,
    topSites: topSites.map((t) => ({ siteId: t.siteId, siteLabel: t.siteLabel ?? null, views: Number(t.views) })),
    windowDays: WINDOW_DAYS,
  }
}

type DayRows = { date: string; n: number }[]

/** Zero-fill the window: one row per day (oldest → newest), merging each metric's sparse counts. */
function buildSeries(
  now: Date,
  metrics: Record<'signups' | 'sites' | 'views' | 'comments' | 'cli', DayRows>,
): DailyPoint[] {
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
      cli: index.cli.get(date) ?? 0,
    })
  }
  return out
}
