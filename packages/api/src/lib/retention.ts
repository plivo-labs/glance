import { and, count, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { events, notifications, purgedEventCounts, siteVersionFiles, siteVersions } from '../db/schema'
import { D1_MAX_IN } from './d1'
import { deleteKeys } from './storage'

// Daily retention purge (issue #82, issue #102 item 2). `events` gets one row per page view AND
// per CLI call (middleware/analytics.ts) with no cap — nothing ever deleted it. `notifications`
// only ever gets `readAt` set, never removed. Both grow forever; this trims them on a daily cron
// (see index.ts `scheduled`), separate from the hourly stats tick.
export const EVENTS_RETENTION_DAYS = 90
export const READ_NOTIFICATIONS_RETENTION_DAYS = 30
// Site version history: a version survives only while it is among the site's newest KEEP AND younger
// than the age cap (both must hold). Age is the SNAPSHOT time, i.e. when the content was superseded.
export const SITE_VERSIONS_KEEP = 10
export const SITE_VERSIONS_RETENTION_DAYS = 30
// One pass handles D1_MAX_IN versions (the id list is bound into inArray); a run stops after
// MAX_PASSES so the Workers subrequest budget (~4 + one R2 delete per 1000 keys per pass) can't be
// blown by a backlog — whatever is left is simply picked up by the next daily run.
const VERSION_PURGE_MAX_PASSES = 10

const DAY_MS = 24 * 60 * 60 * 1000
const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString()

/**
 * Deletes VIEW events older than EVENTS_RETENTION_DAYS and READ notifications (readAt IS NOT NULL)
 * older than READ_NOTIFICATIONS_RETENTION_DAYS. Unread notifications are kept forever — both
 * tables are safe to hard-delete per their FK design (SET NULL on siteId/userId/etc, with
 * denormalized siteLabel), so nothing else needs to change on delete.
 *
 * 'cli' events are deliberately NOT purged: /api/auth/me derives `hasUsedCli` from an EXISTS probe
 * over them (routes/auth.ts), so deleting old rows would flip long-time CLI users back to "never
 * used CLI" and resurface the install banner. Purge them once #85 denormalizes the flag onto
 * `users`. The typed `type = 'view'` predicate rides the existing `events_type_created
 * (type, createdAt)` index (see db/schema.ts), so no new index is needed for events.
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

  await db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, notificationsCutoff)))
}

/**
 * Purges site versions that fell out of the retention window: not among the newest
 * SITE_VERSIONS_KEEP of their site, or older than SITE_VERSIONS_RETENTION_DAYS. A site whose only
 * versions are all past the age cap loses them all — "none older than 30 days" is absolute.
 *
 * ORDER IS THE SAFETY: the R2 objects go first, then the rows, keyed by the EXACT ids selected (the
 * predicate is never re-evaluated at delete time, so a version created mid-run can't be caught by
 * it). If the R2 delete throws, the rows survive and the next run retries; the reverse order would
 * strand the objects with nothing left pointing at them. Deleting a version cascades its file rows.
 */
export async function purgeSiteVersions(db: DrizzleD1Database, bucket: R2Bucket, now: Date = new Date()): Promise<void> {
  const ageCutoff = cutoff(now, SITE_VERSIONS_RETENTION_DAYS)
  for (let pass = 0; pass < VERSION_PURGE_MAX_PASSES; pass++) {
    const doomed = await db.all<{ id: string }>(sql`
      SELECT id FROM (
        SELECT id, createdAt, row_number() OVER (PARTITION BY siteId ORDER BY createdAt DESC, version DESC) AS rn
        FROM site_versions
      ) WHERE rn > ${SITE_VERSIONS_KEEP} OR createdAt < ${ageCutoff}
      LIMIT ${D1_MAX_IN}`)
    if (doomed.length === 0) return
    const ids = doomed.map((r) => r.id)
    const keys = await db
      .select({ storageKey: siteVersionFiles.storageKey })
      .from(siteVersionFiles)
      .where(inArray(siteVersionFiles.versionId, ids))
    await deleteKeys(bucket, keys.map((k) => k.storageKey))
    await db.delete(siteVersions).where(inArray(siteVersions.id, ids))
    if (ids.length < D1_MAX_IN) return
  }
}
