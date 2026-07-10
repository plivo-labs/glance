import { and, eq, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { alias } from 'drizzle-orm/sqlite-core'
import { type ElementAnchor, normalizeText, readElementAnchor } from '../lib/anchor'
import { type Comment, type CommentThread, comments, commentThreads, sites, spaces, users } from './schema'

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

// --- S8: composable list statements + pure assembler. The route fuses the two statements below
// into ITS OWN db.batch (S9b, alongside the access facts) and hands the row arrays to
// `assembleThreadViews`. JOINing users in (and filtering comments THROUGH the thread join)
// removes the old IN(threadIds)/IN(userIds) follow-ups — and with them the D1 bind-cap risk a
// 100+-thread/author site used to carry. -------------------------------------------------------

// Two independent aliases of `users`: a thread joins it twice (creator + resolver).
const threadCreator = alias(users, 'thread_creator')
const threadResolver = alias(users, 'thread_resolver')

/** Row shape of `threadsWithUsersBySlugsStmt`. Joined fields are null on a LEFT-JOIN miss;
 *  `email` is NOT NULL in the schema, so a null email ⇔ the user row is missing (null or
 *  dangling id). */
export type ThreadWithUsersRow = {
  thread: CommentThread
  creatorName: string | null
  creatorEmail: string | null
  resolverName: string | null
  resolverEmail: string | null
}

/** Row shape of `commentsWithAuthorsBySlugsStmt` (same null semantics as above). */
export type CommentWithAuthorRow = {
  comment: Comment
  authorName: string | null
  authorEmail: string | null
}

// Slug-keyed scope for statements fused into the access-facts batch (S9b): the site id is
// unknown before the batch runs, so scope through sites ⨝ spaces on BOTH slugs — site slugs are
// only unique per space, so a lone slug key would bleed across spaces. Non-failing like every
// batched SELECT: a missing site (or an invalid filePath) just matches nothing. Fresh condition
// per call — drizzle builders own their SQL chunks.
const slugThreadScope = (spaceSlug: string, siteSlug: string, filePath?: string) => {
  const key = and(eq(spaces.slug, spaceSlug), eq(sites.slug, siteSlug))
  return filePath === undefined ? key : and(key, eq(commentThreads.filePath, filePath))
}

// The two list statements' select shapes, feeding `assembleThreadViews`.
const THREAD_LIST_COLUMNS = {
  thread: commentThreads,
  creatorName: threadCreator.name,
  creatorEmail: threadCreator.email,
  resolverName: threadResolver.name,
  resolverEmail: threadResolver.email,
}
const COMMENT_LIST_COLUMNS = { comment: comments, authorName: users.name, authorEmail: users.email }

/** Statement: the scoped threads LEFT JOINed to their creator and resolver users, ordered
 *  (filePath, createdAt, rowid). With a filePath filter the filePath key is constant, so the
 *  order degenerates to today's per-file (createdAt, rowid). rowid (insertion order) is the
 *  tiebreaker so same-millisecond rows order totally AND stay chronological — qualified, since
 *  bare `rowid` would be ambiguous after the joins. Keyed by (spaceSlug, siteSlug) — for fusing
 *  into the access-facts batch, where no site id exists yet. */
export function threadsWithUsersBySlugsStmt(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
  filePath?: string,
) {
  return db
    .select(THREAD_LIST_COLUMNS)
    .from(commentThreads)
    .innerJoin(sites, eq(commentThreads.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .leftJoin(threadCreator, eq(commentThreads.createdBy, threadCreator.id))
    .leftJoin(threadResolver, eq(commentThreads.resolvedBy, threadResolver.id))
    .where(slugThreadScope(spaceSlug, siteSlug, filePath))
    .orderBy(commentThreads.filePath, commentThreads.createdAt, sql`"comment_threads".rowid`)
}

/** Statement: the scoped threads' comments (scoped THROUGH the thread join — no IN(threadIds))
 *  LEFT JOINed to their author, ordered (createdAt, rowid) as today; the assembler groups them
 *  per thread preserving this order. Slug-keyed like `threadsWithUsersBySlugsStmt`. */
export function commentsWithAuthorsBySlugsStmt(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
  filePath?: string,
) {
  return db
    .select(COMMENT_LIST_COLUMNS)
    .from(comments)
    .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
    .innerJoin(sites, eq(commentThreads.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(slugThreadScope(spaceSlug, siteSlug, filePath))
    .orderBy(comments.createdAt, sql`"comments".rowid`)
}

/** Display name from JOINed user fields: null id → null; id whose join found no row (dangling
 *  or deleted; null email ⇔ join miss) → null; else name ?? email. */
const joinedDisplayName = (id: string | null, name: string | null, email: string | null): string | null =>
  id == null || email == null ? null : (name ?? email)

/** PURE assembly of the two statements' rows into ThreadView[], in thread-row order. Threads
 *  with zero comments are kept (comments: []); soft-deleted comments keep their row with the
 *  body redacted (toCommentView). No R2, no anchor resolution — painting is the client's job. */
export function assembleThreadViews(threadRows: ThreadWithUsersRow[], commentRows: CommentWithAuthorRow[]): ThreadView[] {
  const byThread = new Map<string, CommentView[]>()
  for (const r of commentRows) {
    const view = toCommentView(r.comment, joinedDisplayName(r.comment.authorId, r.authorName, r.authorEmail))
    const list = byThread.get(r.comment.threadId)
    if (list) list.push(view)
    else byThread.set(r.comment.threadId, [view])
  }
  return threadRows.map(({ thread: t, creatorName, creatorEmail, resolverName, resolverEmail }) => ({
    id: t.id,
    filePath: t.filePath,
    anchorType: t.anchorType,
    quote: t.quote,
    anchor: readElementAnchor(t.anchorType, t.anchor),
    status: t.status,
    resolvedBy: t.resolvedBy,
    resolvedByName: joinedDisplayName(t.resolvedBy, resolverName, resolverEmail),
    resolvedAt: t.resolvedAt,
    createdBy: t.createdBy,
    createdByName: joinedDisplayName(t.createdBy, creatorName, creatorEmail),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    comments: byThread.get(t.id) ?? [],
  }))
}

function toCommentView(c: Comment, author: string | null): CommentView {
  const deleted = c.deletedAt !== null
  return {
    id: c.id,
    authorId: c.authorId,
    author, // identity kept even when the body is redacted
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

// --- S9c: id-keyed target-read statements for fusing into the access-facts batch. The ids come
// from the URL, so every statement is known BEFORE the batch runs, and each is a non-failing
// SELECT (absent → empty) — the binding constraint on anything batched with the facts. ----------

/** Statement: one comment row by id. */
export function commentByIdStmt(db: DrizzleD1Database, commentId: string) {
  return db.select().from(comments).where(eq(comments.id, commentId)).limit(1)
}

/** Statement: one thread row by id. */
export function threadByIdStmt(db: DrizzleD1Database, threadId: string) {
  return db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1)
}

/** Statement: the thread reached THROUGH a comment (comment_threads ⨝ comments on threadId) —
 *  for the audio route, whose URL carries only the comment id: the threadId is unknown pre-batch,
 *  so the join walks the relationship inside the statement instead. */
export function threadOfCommentStmt(db: DrizzleD1Database, commentId: string) {
  return db
    .select({ thread: commentThreads })
    .from(commentThreads)
    .innerJoin(comments, eq(comments.threadId, commentThreads.id))
    .where(eq(comments.id, commentId))
    .limit(1)
}
