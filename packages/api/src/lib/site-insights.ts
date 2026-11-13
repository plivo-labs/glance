import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { events } from '../db/schema'
import { batchAll } from './d1'

// Per-page "Insights" for the site OWNER: counts only, never who. Everything is a bounded range
// scan over the existing events_site_created(siteId, createdAt) index, so cost tracks this one
// site's last 30 days and does not grow with history. The window sits well inside retention
// (EVENTS_RETENTION_DAYS = 90, lib/retention.ts): rows older than that are purged, so this never
// reports a longer span than 30 days.
export const INSIGHTS_DAYS = 30
const TOP_PAGES = 10
const DAY_MS = 24 * 60 * 60 * 1000

export interface SiteInsights {
  days: number
  totalViews: number
  uniqueViewers: number
  series: { date: string; views: number }[] // one zero-filled row per UTC day, oldest → newest
  pages: { path: string; views: number }[] // top pages by views
}

/** YYYY-MM-DD (UTC) — matches substr(createdAt, 1, 10) on our ISO-8601 timestamps. */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

/** View counts for one site over the last INSIGHTS_DAYS UTC calendar days (today back through
 *  29 days ago, from midnight UTC). `totalViews` is the sum of the series, so the headline number
 *  and the chart can never disagree. */
export async function computeSiteInsights(
  db: DrizzleD1Database,
  siteId: string,
  now: Date = new Date(),
): Promise<SiteInsights> {
  const since = `${dayKey(new Date(now.getTime() - (INSIGHTS_DAYS - 1) * DAY_MS))}T00:00:00.000Z`
  const inWindow = and(eq(events.siteId, siteId), eq(events.type, 'view'), gte(events.createdAt, since))
  const day = sql<string>`substr(${events.createdAt}, 1, 10)`
  const views = count().as('views')

  const [byDay, viewers, byPath] = await batchAll(db, [
    db.select({ day: day.as('day'), views }).from(events).where(inWindow).groupBy(day),
    db
      .select({ viewers: sql<number>`count(distinct ${events.userId})`.as('viewers') })
      .from(events)
      .where(inWindow),
    db
      .select({ path: events.action, views })
      .from(events)
      .where(and(inWindow, isNotNull(events.action)))
      .groupBy(events.action)
      .orderBy(desc(views), events.action)
      .limit(TOP_PAGES),
  ])

  const perDay = new Map(byDay.map((r) => [r.day, Number(r.views)]))
  const series = Array.from({ length: INSIGHTS_DAYS }, (_, i) => {
    const date = dayKey(new Date(now.getTime() - (INSIGHTS_DAYS - 1 - i) * DAY_MS))
    return { date, views: perDay.get(date) ?? 0 }
  })

  return {
    days: INSIGHTS_DAYS,
    totalViews: series.reduce((sum, p) => sum + p.views, 0),
    uniqueViewers: Number(viewers[0]?.viewers ?? 0),
    series,
    pages: byPath.map((r) => ({ path: r.path ?? '', views: Number(r.views) })),
  }
}
