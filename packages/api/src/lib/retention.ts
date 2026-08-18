import { and, count, eq, isNotNull, lt, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { events, notifications, purgedEventCounts } from '../db/schema'

// Daily retention purge (issue #82, issue #102 item 2). `events` gets one row per page view AND
// per CLI call (middleware/analytics.ts) with no cap — nothing ever deleted it. `notifications`
// only ever gets `readAt` set, never removed. Both grow forever; this trims them on a daily cron
// (see index.ts `scheduled`), separate from the hourly stats tick.
export const EVENTS_RETENTION_DAYS = 90
export const READ_NOTIFICATIONS_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000
const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString()

/**
 * Deletes events older than EVENTS_RETENTION_DAYS and READ notifications (readAt IS NOT NULL)
 * older than READ_NOTIFICATIONS_RETENTION_DAYS. Unread notifications are kept forever — both
 * tables are safe to hard-delete per their FK design (SET NULL on siteId/userId/etc, with
 * denormalized siteLabel), so nothing else needs to change on delete.
 *
 * Split into two typed deletes (`type = 'view'` / `type = 'cli'`) rather than one bare
 * `createdAt < cutoff` scan: `events_type_created (type, createdAt)` already indexes exactly that
 * shape (see db/schema.ts), so no new index is needed for events.
 */
export async function purgeRetention(db: DrizzleD1Database, now: Date = new Date()): Promise<void> {
  const eventsCutoff = cutoff(now, EVENTS_RETENTION_DAYS)
  const notificationsCutoff = cutoff(now, READ_NOTIFICATIONS_RETENTION_DAYS)

  // Fold doomed 'view' rows into the durable counter BEFORE deleting them, so stats.ts's all-time
  // totals.views can add it back and stay correct after the rows are gone (issue #102's caveat).
  // 'cli' rows feed no total (stats.ts is deliberately CLI-stat-free) so they need no counter.
  const doomedViews = await db
    .select({ n: count() })
    .from(events)
    .where(and(eq(events.type, 'view'), lt(events.createdAt, eventsCutoff)))
    .then((r) => Number(r[0]?.n ?? 0))

  if (doomedViews > 0) {
    await db
      .insert(purgedEventCounts)
      .values({ type: 'view', count: doomedViews })
      .onConflictDoUpdate({
        target: purgedEventCounts.type,
        set: { count: sql`${purgedEventCounts.count} + ${doomedViews}` },
      })
  }

  await db.delete(events).where(and(eq(events.type, 'view'), lt(events.createdAt, eventsCutoff)))
  await db.delete(events).where(and(eq(events.type, 'cli'), lt(events.createdAt, eventsCutoff)))

  await db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, notificationsCutoff)))
}
