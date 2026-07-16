import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { checkAccess } from '../lib/access'
import { batchAll } from '../lib/d1'
import {
  comments,
  type NotificationType,
  notifications,
  type Site,
  siteGroupShares,
  siteUserShares,
  spaceMembers,
  users,
} from './schema'

// Notifications repo: batch create (off the comment path, fire-and-forget), recipient-scoped list
// (+ unread count), and mark-read. Pure D1 — no R2, no anchor resolution. Every function is
// exported so the S-D harness drives it directly.

const now = () => new Date().toISOString()

/** One row to raise. `type` is required ('mention' | 'comment'); id + createdAt are generated.
 *  All targets are optional so a row survives (via denormalized `siteLabel`) after the site/thread/
 *  comment it points at is gone — see the SET NULL FKs in schema. */
export type NotificationInput = {
  recipientId: string
  type: NotificationType
  actorId?: string | null
  siteId?: string | null
  siteLabel?: string | null
  threadId?: string | null
  commentId?: string | null
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
  commentId: string | null
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
      type: r.type,
      actorId: r.actorId ?? null,
      siteId: r.siteId ?? null,
      siteLabel: r.siteLabel ?? null,
      threadId: r.threadId ?? null,
      commentId: r.commentId ?? null,
      filePath: r.filePath ?? null,
      snippet: r.snippet ?? null,
    })),
  )
}

/** Resolve the normal comment audience from targeted facts, excluding the actor and any mention
 *  recipients. Prior participants join the owner and direct shares only for replies; every
 *  candidate is re-authorized against the site's current tier/share policy before notification. */
export async function resolveCommentAudience(
  db: DrizzleD1Database,
  site: Pick<Site, 'id' | 'spaceId' | 'visibility' | 'ownerId' | 'status'>,
  opts: { threadId: string; isReply: boolean; exclude: Set<string> | string[] },
): Promise<string[]> {
  if (site.status === 'archived') return []

  const directSharesStmt = db
    .select({ userId: siteUserShares.userId })
    .from(siteUserShares)
    .where(eq(siteUserShares.siteId, site.id))
  const participantsStmt = db
    .selectDistinct({ authorId: comments.authorId })
    .from(comments)
    .where(and(eq(comments.threadId, opts.threadId), isNotNull(comments.authorId)))
  const audienceFacts = async (): Promise<{
    directRows: { userId: string }[]
    participantRows: { authorId: string | null }[]
  }> => {
    if (opts.isReply) {
      const [directRows, participantRows] = await batchAll(db, [directSharesStmt, participantsStmt])
      return { directRows, participantRows }
    }
    const [directRows] = await batchAll(db, [directSharesStmt])
    return { directRows, participantRows: [] }
  }
  const { directRows, participantRows } = await audienceFacts()
  const directShares = new Set(directRows.map((row) => row.userId))
  // TS-only narrowing; the SQL isNotNull predicate already excludes null authors.
  const participantIds = participantRows
    .map((row) => row.authorId)
    .filter((authorId): authorId is string => authorId !== null)
  const audience = new Set<string>([site.ownerId, ...directShares, ...participantIds])
  const excluded = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude)
  for (const id of excluded) audience.delete(id)
  const candidates = [...audience]
  if (candidates.length === 0) return []

  const groupSharesStmt = db
    .selectDistinct({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .innerJoin(siteGroupShares, eq(spaceMembers.spaceId, siteGroupShares.spaceId))
    .where(and(eq(siteGroupShares.siteId, site.id), inArray(spaceMembers.userId, candidates)))
  const membersStmt = db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, site.spaceId), inArray(spaceMembers.userId, candidates)))
  const accessStatements =
    site.visibility === 'members'
      ? [groupSharesStmt, membersStmt]
      : site.visibility === 'private'
        ? [groupSharesStmt]
        : []
  const accessRows = await batchAll(db, accessStatements)
  const groupRows = accessRows[0] ?? []
  const memberRows = site.visibility === 'members' ? (accessRows[1] ?? []) : []
  const groupSharedIds = new Set(groupRows.map((row) => row.userId))
  const memberIds = new Set(memberRows.map((row) => row.userId))

  return candidates.filter((id) => {
    // Recipient role is deliberately not consulted — superadmins need normal tier/share access to be notified.
    const recipient = { id, role: 'member' as const }
    return checkAccess(site, recipient, memberIds.has(id), directShares.has(id) || groupSharedIds.has(id)).ok
  })
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
      commentId: notifications.commentId,
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
    commentId: r.commentId,
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
