import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { type ElementAnchor, normalizeText, readElementAnchor } from '../lib/anchor'
import { type Comment, type CommentThread, comments, commentThreads, users } from './schema'

// Comments repo: create/list/reply/resolve/edit/soft-delete. Anchors are STORED here but never
// resolved server-side — the browser annotate client re-finds each quote in the rendered DOM to
// paint it (the correct coordinate space). So this module does no R2 reads and computes no
// anchor status; the list path is pure D1. Every function is exported so the S-D harness can
// drive it directly.

const now = () => new Date().toISOString()

/** A batch op that bumps a thread's `updatedAt`. Appended to a comment mutation in the SAME
 *  batch (so it's atomic) to resurface the thread in the updatedAt-sorted rail. */
function touchThread(db: DrizzleD1Database, threadId: string, ts: string) {
  return db.update(commentThreads).set({ updatedAt: ts }).where(eq(commentThreads.id, threadId))
}

export type CommentView = {
  id: string
  authorId: string | null
  author: string | null // display name (name ?? email); kept even when soft-deleted
  body: string | null // null when soft-deleted (redacted)
  deleted: boolean
  hasAudio: boolean // voice comment: has a recording served via the audio route. audioKey never leaks.
  createdAt: string
  editedAt: string | null
}

export type ThreadView = {
  id: string
  filePath: string
  anchorType: 'text' | 'page' | 'element'
  quote: string | null
  anchor: ElementAnchor | null // element threads only; null for text/page (legacy JSON never leaks)
  status: 'open' | 'resolved'
  resolvedBy: string | null
  resolvedByName: string | null
  resolvedAt: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
  comments: CommentView[]
}

/**
 * Build ThreadViews from an ALREADY-QUERIED, ALREADY-ORDERED array of threads, returning views
 * in the SAME order as the input. Comments load in ONE query and group by thread; every
 * referenced author/actor id resolves to a display name in ONE more query. No R2, no anchor
 * resolution — painting is the client's job.
 */
export async function buildThreadViews(db: DrizzleD1Database, threads: CommentThread[]): Promise<ThreadView[]> {
  if (threads.length === 0) return []

  // One query for every thread's comments, ordered as today; group by thread.
  const ids = threads.map((t) => t.id)
  // rowid (insertion order) is the tiebreaker so same-millisecond rows order totally AND stay
  // chronological (a reply never sorts before its opener) — a random `id` UUID would be stable
  // but reorder same-ms rows. Safe: these are rowid tables (text PK, not WITHOUT ROWID).
  const rows = await db
    .select()
    .from(comments)
    .where(inArray(comments.threadId, ids))
    .orderBy(comments.createdAt, sql`rowid`)
  const byThread = new Map<string, Comment[]>()
  for (const c of rows) {
    const list = byThread.get(c.threadId)
    if (list) list.push(c)
    else byThread.set(c.threadId, [c])
  }

  // One query resolving every referenced author/actor id → display name (name ?? email).
  const userIds = new Set<string>()
  for (const t of threads) {
    if (t.createdBy) userIds.add(t.createdBy)
    if (t.resolvedBy) userIds.add(t.resolvedBy)
  }
  for (const c of rows) if (c.authorId) userIds.add(c.authorId)
  const userById = new Map<string, { name: string | null; email: string }>()
  if (userIds.size > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, [...userIds]))
    for (const u of userRows) userById.set(u.id, { name: u.name, email: u.email })
  }
  // null id → null; id with no row (dangling; harness runs FK-off) → null; else name ?? email.
  const displayName = (id: string | null): string | null => {
    if (id == null) return null
    const row = userById.get(id)
    return row ? (row.name ?? row.email) : null
  }

  return threads.map((t) => ({
    id: t.id,
    filePath: t.filePath,
    anchorType: t.anchorType,
    quote: t.quote,
    anchor: readElementAnchor(t.anchorType, t.anchor),
    status: t.status,
    resolvedBy: t.resolvedBy,
    resolvedByName: displayName(t.resolvedBy),
    resolvedAt: t.resolvedAt,
    createdBy: t.createdBy,
    createdByName: displayName(t.createdBy),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    comments: (byThread.get(t.id) ?? []).map((c) => toCommentView(c, displayName)),
  }))
}

/** List a file's threads (+ ordered comments), ordered by createdAt. */
export async function listThreads(db: DrizzleD1Database, siteId: string, filePath: string): Promise<ThreadView[]> {
  const threads = await db
    .select()
    .from(commentThreads)
    .where(and(eq(commentThreads.siteId, siteId), eq(commentThreads.filePath, filePath)))
    .orderBy(commentThreads.createdAt, sql`rowid`)
  return buildThreadViews(db, threads)
}

/** List EVERY thread on a site (+ ordered comments), ordered by (filePath ASC, createdAt ASC). */
export async function listSiteThreads(db: DrizzleD1Database, siteId: string): Promise<ThreadView[]> {
  const threads = await db
    .select()
    .from(commentThreads)
    .where(eq(commentThreads.siteId, siteId))
    .orderBy(commentThreads.filePath, commentThreads.createdAt, sql`rowid`)
  return buildThreadViews(db, threads)
}

function toCommentView(c: Comment, displayName: (id: string | null) => string | null): CommentView {
  const deleted = c.deletedAt !== null
  return {
    id: c.id,
    authorId: c.authorId,
    author: displayName(c.authorId), // identity kept even when the body is redacted
    body: deleted ? null : c.body,
    deleted,
    // Expose only the existence of audio; the R2 key is internal and served via the audio route.
    hasAudio: !deleted && c.audioKey !== null,
    createdAt: c.createdAt,
    editedAt: c.editedAt,
  }
}

export type CreateThreadInput = {
  siteId: string
  filePath: string
  createdBy: string
  body: string
  anchorType?: 'text' | 'page' | 'element'
  quote?: string
  anchor?: ElementAnchor // a built element anchor (see lib/anchor); required when anchorType='element'
  // Voice comments (S-B): the route pre-generates the comment id so it can name the R2 audio object
  // BEFORE the D1 insert, then stores that key here — one id ties the row to its recording.
  commentId?: string
  audioKey?: string
}

/** Create a thread + its opening comment atomically. An element anchor stores its built selector
 *  payload in the JSON `anchor` column; a text anchor stores the normalized quote; a missing quote
 *  (or an explicit page anchor) stores a page thread. No resolution — the client paints the anchor
 *  against the rendered DOM at view time. */
export async function createThread(
  db: DrizzleD1Database,
  input: CreateThreadInput,
): Promise<{ threadId: string; openingCommentId: string }> {
  const isElement = input.anchorType === 'element' && input.anchor != null
  const wantsText = !isElement && (input.anchorType ?? 'text') === 'text' && Boolean(input.quote)
  const anchorType: 'text' | 'page' | 'element' = isElement ? 'element' : wantsText ? 'text' : 'page'
  const quote = wantsText ? normalizeText(input.quote as string) : null
  const anchor = isElement ? (input.anchor as ElementAnchor) : null

  const threadId = crypto.randomUUID()
  const openingCommentId = input.commentId ?? crypto.randomUUID()
  await db.batch([
    db.insert(commentThreads).values({
      id: threadId,
      siteId: input.siteId,
      filePath: input.filePath,
      anchorType,
      quote,
      anchor,
      status: 'open',
      createdBy: input.createdBy,
    }),
    db.insert(comments).values({
      id: openingCommentId,
      threadId,
      authorId: input.createdBy,
      body: input.body,
      audioKey: input.audioKey ?? null,
    }),
  ])
  return { threadId, openingCommentId }
}

/** Append a flat reply to a thread (no nesting) and bump the thread's updatedAt. */
export async function addComment(
  db: DrizzleD1Database,
  input: { threadId: string; authorId: string; body: string; commentId?: string; audioKey?: string },
): Promise<string> {
  const id = input.commentId ?? crypto.randomUUID()
  await db.batch([
    db.insert(comments).values({
      id,
      threadId: input.threadId,
      authorId: input.authorId,
      body: input.body,
      audioKey: input.audioKey ?? null,
    }),
    touchThread(db, input.threadId, now()),
  ])
  return id
}

export async function resolveThread(db: DrizzleD1Database, threadId: string, userId: string): Promise<void> {
  const ts = now()
  await db
    .update(commentThreads)
    .set({ status: 'resolved', resolvedBy: userId, resolvedAt: ts, updatedAt: ts })
    .where(eq(commentThreads.id, threadId))
}

export async function reopenThread(db: DrizzleD1Database, threadId: string): Promise<void> {
  await db
    .update(commentThreads)
    .set({ status: 'open', resolvedBy: null, resolvedAt: null, updatedAt: now() })
    .where(eq(commentThreads.id, threadId))
}

export async function editComment(
  db: DrizzleD1Database,
  threadId: string,
  commentId: string,
  body: string,
): Promise<void> {
  const ts = now()
  await db.batch([
    db.update(comments).set({ body, editedAt: ts }).where(eq(comments.id, commentId)),
    touchThread(db, threadId, ts),
  ])
}

/** Soft delete: keep the row (and thread shape); body is redacted on read. Bumps the thread so
 *  the change resurfaces in the updatedAt-sorted rail. Voice asymmetry: the audio is hard-deleted
 *  (the caller fires the R2 delete), so we null `audioKey` here — the row survives redacted, but
 *  hasAudio flips false and the audio route 404s. */
export async function deleteComment(db: DrizzleD1Database, threadId: string, commentId: string): Promise<void> {
  const ts = now()
  await db.batch([
    db.update(comments).set({ deletedAt: ts, audioKey: null }).where(eq(comments.id, commentId)),
    touchThread(db, threadId, ts),
  ])
}

export async function getComment(db: DrizzleD1Database, commentId: string): Promise<Comment | null> {
  return (await db.select().from(comments).where(eq(comments.id, commentId)).limit(1))[0] ?? null
}

export async function getThread(db: DrizzleD1Database, threadId: string): Promise<CommentThread | null> {
  return (await db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1))[0] ?? null
}
