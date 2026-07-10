import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { type NotificationType, notifications, users } from './schema'

// Notifications repo: batch create (off the comment path, fire-and-forget), recipient-scoped list
// (+ unread count), and mark-read. Pure D1 — no R2, no anchor resolution. Every function is
// exported so the S-D harness drives it directly.

const now = () => new Date().toISOString()

/** One row to raise. `type` defaults to 'mention'; id + createdAt are generated. All targets are
 *  optional so a row survives (via denormalized `siteLabel`) after the site/thread it points at is
 *  gone — see the SET NULL FKs in schema. */
export type NotificationInput = {
  recipientId: string
  type?: NotificationType
  actorId?: string | null
  siteId?: string | null
  siteLabel?: string | null
  threadId?: string | null
  filePath?: string | null
  snippet?: string | null
}

export type NotificationView = {
  id: string
  type: NotificationType
  actorId: string | null
  actorName: string | null // display name (name ?? email); null once the actor is deleted
  siteLabel: string | null
  filePath: string | null
  threadId: string | null
  snippet: string | null
  read: boolean
  readAt: string | null
  createdAt: string
}

/** Insert a batch of notifications in one statement. Empty batch is a no-op (never touches D1). */
export async function createNotifications(db: DrizzleD1Database, rows: NotificationInput[]): Promise<void> {
  if (rows.length === 0) return
  await db.insert(notifications).values(
    rows.map((r) => ({
      recipientId: r.recipientId,
      type: r.type ?? 'mention',
      actorId: r.actorId ?? null,
      siteId: r.siteId ?? null,
      siteLabel: r.siteLabel ?? null,
      threadId: r.threadId ?? null,
      filePath: r.filePath ?? null,
      snippet: r.snippet ?? null,
    })),
  )
}

/** A recipient's notifications, newest-first, plus the FULL unread count (independent of `limit`).
 *  The actor's display name resolves in the same query (left join — survives actor deletion as
 *  null). Ordered by createdAt desc with rowid desc as the same-millisecond tiebreaker. */
export async function listNotifications(
  db: DrizzleD1Database,
  userId: string,
  limit = 30,
): Promise<{ items: NotificationView[]; unreadCount: number }> {
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      actorId: notifications.actorId,
      actorName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
      siteLabel: notifications.siteLabel,
      filePath: notifications.filePath,
      threadId: notifications.threadId,
      snippet: notifications.snippet,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorId))
    .where(eq(notifications.recipientId, userId))
    .orderBy(desc(notifications.createdAt), sql`notifications.rowid desc`)
    .limit(limit)

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.recipientId, userId), isNull(notifications.readAt)))

  const items: NotificationView[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    actorId: r.actorId,
    actorName: r.actorName,
    siteLabel: r.siteLabel,
    filePath: r.filePath,
    threadId: r.threadId,
    snippet: r.snippet,
    read: r.readAt !== null,
    readAt: r.readAt,
    createdAt: r.createdAt,
  }))
  return { items, unreadCount: Number(c) }
}

/** Mark the caller's notifications read. With `ids`, only those; otherwise all. ALWAYS scoped to
 *  `recipientId = userId` (a foreign id in `ids` can never cross that boundary) and gated on
 *  still-unread rows so re-marking is idempotent (never rewrites an existing readAt). */
export async function markRead(db: DrizzleD1Database, userId: string, ids?: string[]): Promise<void> {
  // Absent ids → mark all; a provided list → only those; an explicit empty list → nothing (an
  // empty selection must never be read as "mark everything").
  if (ids !== undefined && ids.length === 0) return
  const scope =
    ids && ids.length > 0
      ? and(eq(notifications.recipientId, userId), inArray(notifications.id, ids))
      : eq(notifications.recipientId, userId)
  await db
    .update(notifications)
    .set({ readAt: now() })
    .where(and(scope, isNull(notifications.readAt)))
}
