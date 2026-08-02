import { and, eq, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { alias } from 'drizzle-orm/sqlite-core'
import {
  type ElementAnchor,
  type StoredTextContext,
  TEXT_CONTEXT_VERSION,
  type TextContext,
  normalizeText,
  readElementAnchor,
  readTextContext,
} from '../lib/anchor'
import {
  type Comment,
  type CommentReactionRow,
  type CommentThread,
  commentReactions,
  comments,
  commentThreads,
  sites,
  spaces,
  users,
} from './schema'

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

/** One DISTINCT emoji on a comment, aggregated server-side: how many people used it, whether the
 *  caller is one of them, and WHO the others are — a chip that only counts leaves the reader
 *  guessing. `names` are EVERY other reactor's display name in reaction order, never including the
 *  caller (that is `mine`), so `count` is `names.length` plus the caller. Uncapped on purpose: the
 *  tooltip names everyone, and a comment's reactors are bounded by the people who can see the page.
 *  Reactor IDS still never leave the server. */
export type CommentReaction = { emoji: string; count: number; mine: boolean; names: string[] }

export type CommentView = {
  id: string
  authorId: string | null
  author: string | null // display name (name ?? email); kept even when soft-deleted
  body: string | null // null when soft-deleted (redacted)
  deleted: boolean
  hasAudio: boolean // voice comment: has a recording served via the audio route. audioKey never leaks.
  // One entry per distinct emoji, first-reacted-first; [] when nobody has reacted. Kept on a
  // soft-deleted comment too: the delete redacts the BODY, it does not rewrite who reacted to it.
  reactions: CommentReaction[]
  createdAt: string
  editedAt: string | null
}

export type ThreadView = {
  id: string
  filePath: string
  anchorType: 'text' | 'page' | 'element'
  quote: string | null
  anchor: ElementAnchor | null // element threads only; null for text/page (legacy JSON never leaks)
  // Text threads only: the {prefix,suffix} captured around the selection, which tells REPEATED
  // occurrences of the same quote apart. Null on element/page rows and on text rows stored before
  // context existed — the client then falls back to first-occurrence matching.
  context: TextContext | null
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

// The two list statements' select shapes, feeding `assembleThreadViews`. The four user columns
// carry explicit SQL aliases: both users aliases emit result columns named `name`/`email`, and
// real D1 `.batch()` maps rows BY NAME, collapsing duplicates (the harness guard enforces this).
const THREAD_LIST_COLUMNS = {
  thread: commentThreads,
  creatorName: sql<string | null>`${threadCreator.name}`.as('creatorName'),
  creatorEmail: sql<string | null>`${threadCreator.email}`.as('creatorEmail'),
  resolverName: sql<string | null>`${threadResolver.name}`.as('resolverName'),
  resolverEmail: sql<string | null>`${threadResolver.email}`.as('resolverEmail'),
}
const COMMENT_LIST_COLUMNS = { comment: comments, authorName: users.name, authorEmail: users.email }
// Reaction rows are read RAW (one row per reactor) and aggregated in `reactionsByComment`. A
// GROUP BY would be one row per (comment, emoji) — but `mine` needs the caller's own row, so the
// grouped form would still owe a second correlated read. Folding in JS costs one pass over rows
// that are already bounded per comment (20 distinct emojis per user) and keeps the read to ONE
// statement. `createdAt` is read only to order them; the reactor ids never leave the server —
// the JOINed name/email do, aggregated into `names` exactly like a comment author's is.
const REACTION_COLUMNS = {
  commentId: commentReactions.commentId,
  userId: commentReactions.userId,
  emoji: commentReactions.emoji,
  reactorName: users.name,
  reactorEmail: users.email,
}

/** Row shape of both reaction statements — the raw (comment, reactor, emoji) triples, plus the
 *  reactor's JOINed user fields (same null-on-miss semantics as the rows above). */
export type ReactionRow = Pick<CommentReactionRow, 'commentId' | 'userId' | 'emoji'> & {
  reactorName: string | null
  reactorEmail: string | null
}

const reactionOrder = [commentReactions.createdAt, sql`"comment_reactions".rowid`] as const

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

/** Statement: the scoped threads' comments' reaction rows, scoped THROUGH the same thread join the
 *  two statements above use — so it fuses into the list route's ONE batch instead of costing a
 *  second round trip. Slug-keyed for the same reason: no site id exists before that batch runs. */
export function reactionsBySlugsStmt(db: DrizzleD1Database, spaceSlug: string, siteSlug: string, filePath?: string) {
  return db
    .select(REACTION_COLUMNS)
    .from(commentReactions)
    .innerJoin(comments, eq(commentReactions.commentId, comments.id))
    .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
    .innerJoin(sites, eq(commentThreads.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .leftJoin(users, eq(commentReactions.userId, users.id))
    .where(slugThreadScope(spaceSlug, siteSlug, filePath))
    .orderBy(...reactionOrder)
}

/** Statement: one comment's reaction rows, id-keyed — for the toggle routes, whose commentId comes
 *  from the URL (so it fuses into their access batch) and whose response is this same set. */
export function reactionsByCommentStmt(db: DrizzleD1Database, commentId: string) {
  return db
    .select(REACTION_COLUMNS)
    .from(commentReactions)
    .leftJoin(users, eq(commentReactions.userId, users.id))
    .where(eq(commentReactions.commentId, commentId))
    .orderBy(...reactionOrder)
}

/** PURE aggregation of raw reaction rows into the per-comment wire shape, keyed by commentId.
 *  Rows arrive in reaction order, so each comment's emojis come out first-reacted-first and the
 *  chips hold their position as counts change. `viewerId` null (no caller) ⇒ `mine` is never true. */
export function reactionsByComment(rows: ReactionRow[], viewerId: string | null): Map<string, CommentReaction[]> {
  const byComment = new Map<string, CommentReaction[]>()
  for (const r of rows) {
    let list = byComment.get(r.commentId)
    if (!list) {
      list = []
      byComment.set(r.commentId, list)
    }
    const mine = r.userId === viewerId
    const hit = list.find((x) => x.emoji === r.emoji)
    if (hit) {
      hit.count++
      hit.mine ||= mine
      addReactorName(hit, r, mine)
    } else {
      const entry = { emoji: r.emoji, count: 1, mine, names: [] }
      addReactorName(entry, r, mine)
      list.push(entry)
    }
  }
  return byComment
}

/** Append one reactor to a chip's `names`, or don't: the caller is `mine` rather than a name, and a
 *  reactor whose user row is missing (impossible under the FK, but the join is typed for it) is
 *  left out rather than named wrongly — `count` still has them. */
function addReactorName(entry: CommentReaction, row: ReactionRow, mine: boolean): void {
  if (mine) return
  const name = joinedDisplayName(row.userId, row.reactorName, row.reactorEmail)
  if (name !== null) entry.names.push(name)
}

/** Display name from JOINed user fields: null id → null; id whose join found no row (dangling
 *  or deleted; null email ⇔ join miss) → null; else name ?? email. */
const joinedDisplayName = (id: string | null, name: string | null, email: string | null): string | null =>
  id == null || email == null ? null : (name ?? email)

/** PURE assembly of the three statements' rows into ThreadView[], in thread-row order. Threads
 *  with zero comments are kept (comments: []); soft-deleted comments keep their row with the
 *  body redacted (toCommentView). No R2, no anchor resolution — painting is the client's job.
 *  `viewerId` is whose `mine` the reactions answer for. */
export function assembleThreadViews(
  threadRows: ThreadWithUsersRow[],
  commentRows: CommentWithAuthorRow[],
  reactionRows: ReactionRow[],
  viewerId: string | null,
): ThreadView[] {
  const reactions = reactionsByComment(reactionRows, viewerId)
  const byThread = new Map<string, CommentView[]>()
  for (const r of commentRows) {
    const view = toCommentView(
      r.comment,
      joinedDisplayName(r.comment.authorId, r.authorName, r.authorEmail),
      reactions.get(r.comment.id) ?? [],
    )
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
    context: readTextContext(t.anchorType, t.anchor),
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

// --- S4 (realtime): viewer-independent push payload builders. Reuse the SAME assembly the list
// route runs (assembleThreadViews / toCommentView) instead of a hand-rolled second shape — the
// contract the caller (S5) exists to protect: a pushed thread and a reloaded thread must be
// byte-identical, or live and reloaded silently drift apart. A push has no single viewer (one
// frame goes to everyone in the room), so both builders pass viewerId null / an empty reaction
// row list — reactions: [] on a push (decision 2), which is also the truthful state of a
// brand-new comment, not a lossy one. Row-shaped inputs (ThreadWithUsersRow / CommentWithAuthorRow)
// so the author name resolves through the SAME joinedDisplayName the list endpoint's SQL join
// feeds — the create path's `c.get('user')` fields slot in unchanged, drift-proof by construction.

/** Push payload for a just-created thread + its opening comment: the exact ThreadView the list
 *  route would return for it. */
export function buildThreadCreatedView(threadRow: ThreadWithUsersRow, commentRow: CommentWithAuthorRow): ThreadView {
  return assembleThreadViews([threadRow], [commentRow], [], null)[0]
}

/** Push payload for a reply: `{ threadId, comment }`, `comment` being the exact CommentView shape
 *  the list route nests under its thread. */
export function buildCommentCreatedView(
  threadId: string,
  commentRow: CommentWithAuthorRow,
): { threadId: string; comment: CommentView } {
  const { comment, authorName, authorEmail } = commentRow
  return { threadId, comment: toCommentView(comment, joinedDisplayName(comment.authorId, authorName, authorEmail), []) }
}

function toCommentView(c: Comment, author: string | null, reactions: CommentReaction[]): CommentView {
  const deleted = c.deletedAt !== null
  return {
    id: c.id,
    authorId: c.authorId,
    author, // identity kept even when the body is redacted
    body: deleted ? null : c.body,
    deleted,
    // Expose only the existence of audio; the R2 key is internal and served via the audio route.
    hasAudio: !deleted && c.audioKey !== null,
    reactions,
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
  element?: ElementAnchor
  context?: StoredTextContext
  // Voice comments (S-B): the route pre-generates the comment id so it can name the R2 audio object
  // BEFORE the D1 insert, then stores that key here — one id ties the row to its recording.
  commentId?: string
  audioKey?: string
}

/** RUNTIME version gate on the write path. `StoredTextContext` is a compile-time shape and TS types
 *  are erased, so the declared field constrains only the callers the compiler can see — the param is
 *  typed `unknown` to say exactly that. Two reasons a mis-versioned payload must never be persisted:
 *  `readTextContext` gates READS on the same `v`, so an unversioned row would list back as
 *  `context: null` and silently revert to first-occurrence painting with no error anywhere; and the
 *  `anchor` column still holds a DIFFERENT legacy `{quote,prefix,suffix}` model on rows already in
 *  the production database, so the version is also what keeps that stale, differently-normalized
 *  context from re-anchoring an old thread. Anything unversioned stores null — the pre-context
 *  behaviour, which is a complete answer. */
function versionedContext(context: unknown): StoredTextContext | null {
  const c = context as StoredTextContext | null | undefined
  return c != null && c.v === TEXT_CONTEXT_VERSION ? c : null
}

/** Create a thread + its opening comment atomically. An element anchor stores its built selector
 *  payload in the JSON `anchor` column; a text anchor stores the normalized quote (plus its
 *  occurrence context in that same column); a missing quote (or an explicit page anchor) stores a
 *  page thread. No resolution — the client paints the anchor against the rendered DOM at view time.
 *
 *  Returns the exact rows just inserted (`thread`/`comment`), not a re-read: `createdAt` is
 *  computed here as a plain local `ts` instead of the columns' `$defaultFn`, so the value handed
 *  to `.values()` and the value handed back are the SAME string — the S5 realtime push builds its
 *  payload from this return with ZERO extra D1 round trips (a re-read would blow the D1
 *  request-count budget T9.5 pins on this route). */
export async function createThread(
  db: DrizzleD1Database,
  input: CreateThreadInput,
): Promise<{ threadId: string; openingCommentId: string; thread: CommentThread; comment: Comment }> {
  const isElement = input.anchorType === 'element' && input.element != null
  const wantsText = !isElement && (input.anchorType ?? 'text') === 'text' && Boolean(input.quote)
  const anchorType: 'text' | 'page' | 'element' = isElement ? 'element' : wantsText ? 'text' : 'page'
  const quote = wantsText ? normalizeText(input.quote as string) : null
  // The one JSON column carries whichever payload this anchorType owns — an element's selector, or
  // a text anchor's occurrence context. A page thread (and a text thread with no context) stores null.
  const anchor = anchorType === 'element' ? (input.element ?? null) : anchorType === 'text' ? versionedContext(input.context) : null

  const ts = now()
  const threadId = crypto.randomUUID()
  const openingCommentId = input.commentId ?? crypto.randomUUID()
  const thread: CommentThread = {
    id: threadId,
    siteId: input.siteId,
    filePath: input.filePath,
    anchorType,
    quote,
    anchor,
    contentHash: null,
    anchorStatus: 'anchored',
    start: null,
    end: null,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  }
  const comment: Comment = {
    id: openingCommentId,
    threadId,
    authorId: input.createdBy,
    body: input.body,
    createdAt: ts,
    editedAt: null,
    deletedAt: null,
    audioKey: input.audioKey ?? null,
  }
  await db.batch([db.insert(commentThreads).values(thread), db.insert(comments).values(comment)])
  return { threadId, openingCommentId, thread, comment }
}

/** Append a flat reply to a thread (no nesting) and bump the thread's updatedAt. Returns the exact
 *  row just inserted — its own `id` included, so there is no second field to keep in step with it
 *  — see `createThread`'s note on why this is a local `ts`, not a re-read. */
export async function addComment(
  db: DrizzleD1Database,
  input: { threadId: string; authorId: string; body: string; commentId?: string; audioKey?: string },
): Promise<Comment> {
  const ts = now()
  const comment: Comment = {
    id: input.commentId ?? crypto.randomUUID(),
    threadId: input.threadId,
    authorId: input.authorId,
    body: input.body,
    createdAt: ts,
    editedAt: null,
    deletedAt: null,
    audioKey: input.audioKey ?? null,
  }
  await db.batch([db.insert(comments).values(comment), touchThread(db, input.threadId, ts)])
  return comment
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
 *  hasAudio flips false and the audio route 404s.
 *
 *  #116 narrowed WHEN this runs: a tombstone is only worth rendering when it holds the context for
 *  replies that are still there, so this is now the OPENING comment's delete alone. Everything else
 *  takes `hardDeleteComment` / `deleteThread` below. */
export async function deleteComment(db: DrizzleD1Database, threadId: string, commentId: string): Promise<void> {
  const ts = now()
  await db.batch([
    db.update(comments).set({ deletedAt: ts, audioKey: null }).where(eq(comments.id, commentId)),
    touchThread(db, threadId, ts),
  ])
}

/** Hard delete one comment: the row goes, and with it its reactions (comment_reactions.commentId
 *  cascades). Notifications pointing at it survive — notifications.commentId is `set null`, and the
 *  row's denormalized siteLabel/filePath/snippet keep it readable; only its deep link stops
 *  focusing a thread. Same thread bump as the soft path, for the same reason. */
export async function hardDeleteComment(db: DrizzleD1Database, threadId: string, commentId: string): Promise<void> {
  await db.batch([db.delete(comments).where(eq(comments.id, commentId)), touchThread(db, threadId, now())])
}

/** Delete a whole thread — for when its last meaningful comment goes (#116 case 3). One statement:
 *  comments.threadId cascades from comment_threads, so the thread's comments (and their reactions,
 *  cascading again) go with it. No thread bump: there is no thread left to resurface. */
export async function deleteThread(db: DrizzleD1Database, threadId: string): Promise<void> {
  await db.delete(commentThreads).where(eq(commentThreads.id, threadId))
}

/** Statement: the thread's comments in the SAME order the list route assembles them (createdAt,
 *  rowid), so `[0]` is the opening comment by the one definition the rail already renders. Id-keyed
 *  from the URL, so it fuses into the delete route's access batch. Only what the decision needs:
 *  identity, tombstone state, and the audio each row would orphan. */
export function commentsByThreadStmt(db: DrizzleD1Database, threadId: string) {
  return db
    .select({ id: comments.id, deletedAt: comments.deletedAt, audioKey: comments.audioKey })
    .from(comments)
    .where(eq(comments.threadId, threadId))
    .orderBy(comments.createdAt, sql`"comments".rowid`)
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
