import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { type Anchor, type AnchorStatus, buildAnchor, resolveAnchor } from '../lib/anchor'
import { type Comment, type CommentThread, comments, commentThreads, files, users } from './schema'

// Comments repo: create/list/reply/resolve/edit/soft-delete, plus the SERVER-SIDE re-anchor
// reconciliation. Anchor resolution happens here over trusted R2 bytes — never trusted from
// iframe-computed offsets. This is the correctness surface; every function is exported so the
// S-D harness can drive it directly.

/** The only R2 surface this module needs: read a file body as text. Keeps the repo testable
 *  with the harness `makeR2` mock and free of the full `R2Bucket` type. */
export type FileReader = { get(key: string): Promise<{ text(): Promise<string> } | null> }

const now = () => new Date().toISOString()

/** A batch op that bumps a thread's `updatedAt`. Appended to a comment mutation in the SAME
 *  batch (so it's atomic) to resurface the thread in the updatedAt-sorted rail. */
function touchThread(db: DrizzleD1Database, threadId: string, ts: string) {
  return db.update(commentThreads).set({ updatedAt: ts }).where(eq(commentThreads.id, threadId))
}

/** Read a file body from R2 as text, or null if the object is gone. One get per call. */
async function readText(r2: FileReader, key: string): Promise<string | null> {
  const obj = await r2.get(key)
  return obj ? await obj.text() : null
}

export type CommentView = {
  id: string
  authorId: string | null
  author: string | null // display name (name ?? email); kept even when soft-deleted
  body: string | null // null when soft-deleted (redacted)
  deleted: boolean
  createdAt: string
  editedAt: string | null
}

export type ThreadView = {
  id: string
  filePath: string
  anchorType: 'text' | 'page'
  anchor: Anchor | null
  quote: string | null
  contentHash: string | null
  anchorStatus: AnchorStatus
  start: number | null
  end: number | null
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

/** Current stored body + R2 key + hash for a (site, path), or null if no such file. */
async function currentFile(
  db: DrizzleD1Database,
  siteId: string,
  filePath: string,
): Promise<{ storageKey: string; contentHash: string | null } | null> {
  const row = (
    await db
      .select({ storageKey: files.storageKey, contentHash: files.contentHash })
      .from(files)
      .where(and(eq(files.siteId, siteId), eq(files.path, filePath)))
      .limit(1)
  )[0]
  return row ?? null
}

// Fields the reconciler may rewrite. Returned only when they actually changed, so a no-op
// listThreads writes nothing.
type ReconcilePatch = {
  anchorStatus: AnchorStatus
  start: number | null
  end: number | null
  contentHash: string | null
}

/** Re-resolve one thread against the current file text. `text` is null when the file is gone
 *  (→ orphaned). Returns a patch only if something changed; null otherwise. Page-level threads
 *  and threads whose stored hash already matches never reach here. */
function reconcilePatch(t: CommentThread, text: string | null, currentHash: string | null): ReconcilePatch | null {
  let next: ReconcilePatch
  if (text === null) {
    // File is gone → orphaned, and CLEAR the hash. Keeping the old hash would let a later
    // re-upload of identical bytes (same hash) slip past the stale gate, stranding the thread
    // orphaned forever; a null hash guarantees the next resolve runs when the file returns.
    next = { anchorStatus: 'orphaned', start: null, end: null, contentHash: null }
  } else {
    const prior = t.start !== null && t.end !== null ? { start: t.start, end: t.end } : undefined
    const res = resolveAnchor(t.anchor as Anchor, text, prior)
    next = { anchorStatus: res.status, start: res.start, end: res.end, contentHash: currentHash }
  }
  // One change-detector for both paths: persist only a real change, so a no-op list writes nothing.
  const unchanged =
    next.anchorStatus === t.anchorStatus &&
    next.start === t.start &&
    next.end === t.end &&
    next.contentHash === t.contentHash
  return unchanged ? null : next
}

/**
 * Build ThreadViews from an ALREADY-QUERIED, ALREADY-ORDERED array of threads, reconciling
 * anchors first and returning views in the SAME order as the input. Threads are grouped by
 * filePath internally; the cheap hash gate runs per group (only text-anchored threads whose
 * stored `contentHash` differs from that file's current hash are re-resolved), and each stale
 * file's R2 body is read AT MOST ONCE (and only if a thread needs it). Files and comments load
 * in ONE query each (no per-file/per-thread N+1), and every referenced author/actor id resolves
 * to a display name in ONE more query.
 *
 * PRECONDITION: all threads belong to the SAME site — `siteId` is taken from `threads[0]` to scope
 * the file lookup. Both callers (listThreads, listSiteThreads) query a single site, which holds.
 */
export async function buildThreadViews(
  db: DrizzleD1Database,
  r2: FileReader,
  threads: CommentThread[],
): Promise<ThreadView[]> {
  if (threads.length === 0) return []
  const siteId = threads[0].siteId

  // One query for every referenced file → Map<path, {storageKey, contentHash}> (no N+1).
  const paths = [...new Set(threads.map((t) => t.filePath))]
  const fileRows = await db
    .select({ path: files.path, storageKey: files.storageKey, contentHash: files.contentHash })
    .from(files)
    .where(and(eq(files.siteId, siteId), inArray(files.path, paths)))
  const fileByPath = new Map(fileRows.map((f) => [f.path, { storageKey: f.storageKey, contentHash: f.contentHash }]))

  // Group by file and reconcile per group: a thread whose file row is absent → text=null → orphaned.
  const byFile = new Map<string, CommentThread[]>()
  for (const t of threads) {
    const list = byFile.get(t.filePath)
    if (list) list.push(t)
    else byFile.set(t.filePath, [t])
  }
  for (const [path, group] of byFile) {
    const file = fileByPath.get(path) ?? null
    const currentHash = file?.contentHash ?? null
    const stale = group.filter((t) => t.anchorType === 'text' && t.anchor && t.contentHash !== currentHash)
    if (stale.length === 0) continue
    const text = file ? await readText(r2, file.storageKey) : null
    for (const t of stale) {
      const patch = reconcilePatch(t, text, currentHash)
      if (!patch) continue
      Object.assign(t, patch) // reflect new state in the returned view
      await db.update(commentThreads).set(patch).where(eq(commentThreads.id, t.id))
    }
  }

  // One query for every thread's comments, ordered as today; group by thread.
  const ids = threads.map((t) => t.id)
  const rows = await db.select().from(comments).where(inArray(comments.threadId, ids)).orderBy(comments.createdAt)
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
    anchor: t.anchor as Anchor | null,
    quote: t.quote,
    contentHash: t.contentHash,
    anchorStatus: t.anchorStatus,
    start: t.start,
    end: t.end,
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

/**
 * List a file's threads (+ ordered comments), reconciling anchors first. Cheap hash gate: only
 * text-anchored threads whose stored `contentHash` differs from the file's current hash are
 * re-resolved, and the R2 body is read AT MOST ONCE per call (and only if any thread needs it).
 */
export async function listThreads(
  db: DrizzleD1Database,
  r2: FileReader,
  siteId: string,
  filePath: string,
): Promise<ThreadView[]> {
  const threads = await db
    .select()
    .from(commentThreads)
    .where(and(eq(commentThreads.siteId, siteId), eq(commentThreads.filePath, filePath)))
    .orderBy(commentThreads.createdAt)
  return buildThreadViews(db, r2, threads)
}

/**
 * List EVERY thread on a site (+ ordered comments), reconciling anchors first. Threads come back
 * ordered by (filePath ASC, createdAt ASC); reconciliation runs per file with the same cheap
 * hash gate and at-most-one-R2-read-per-file guarantee as the per-file `listThreads`.
 */
export async function listSiteThreads(db: DrizzleD1Database, r2: FileReader, siteId: string): Promise<ThreadView[]> {
  const threads = await db
    .select()
    .from(commentThreads)
    .where(eq(commentThreads.siteId, siteId))
    .orderBy(commentThreads.filePath, commentThreads.createdAt)
  return buildThreadViews(db, r2, threads)
}

function toCommentView(c: Comment, displayName: (id: string | null) => string | null): CommentView {
  const deleted = c.deletedAt !== null
  return {
    id: c.id,
    authorId: c.authorId,
    author: displayName(c.authorId), // identity kept even when the body is redacted
    body: deleted ? null : c.body,
    deleted,
    createdAt: c.createdAt,
    editedAt: c.editedAt,
  }
}

export type CreateThreadInput = {
  siteId: string
  filePath: string
  createdBy: string
  body: string
  anchorType?: 'text' | 'page'
  quote?: string
  prefix?: string
  suffix?: string
}

/** Create a thread + its opening comment atomically. For a text anchor, resolves the quote
 *  SERVER-SIDE against the file's current text (anchored/shifted/suggested/orphaned); a missing
 *  quote/file degrades to orphaned. Page anchors carry no offsets. */
export async function createThread(
  db: DrizzleD1Database,
  r2: FileReader,
  input: CreateThreadInput,
): Promise<{ threadId: string; anchorStatus: AnchorStatus }> {
  const wantsText = (input.anchorType ?? 'text') === 'text' && Boolean(input.quote)
  let anchorType: 'text' | 'page' = 'page'
  let anchor: Anchor | null = null
  let quote: string | null = null
  let contentHash: string | null = null
  let anchorStatus: AnchorStatus = 'anchored'
  let start: number | null = null
  let end: number | null = null

  if (wantsText) {
    anchorType = 'text'
    anchor = buildAnchor({ quote: input.quote as string, prefix: input.prefix, suffix: input.suffix })
    quote = anchor.quote
    const file = await currentFile(db, input.siteId, input.filePath)
    contentHash = file?.contentHash ?? null
    const text = file ? await readText(r2, file.storageKey) : null
    if (text !== null) {
      const res = resolveAnchor(anchor, text)
      anchorStatus = res.status
      start = res.start
      end = res.end
    } else {
      anchorStatus = 'orphaned' // start/end stay null
    }
  }

  const threadId = crypto.randomUUID()
  await db.batch([
    db.insert(commentThreads).values({
      id: threadId,
      siteId: input.siteId,
      filePath: input.filePath,
      anchorType,
      anchor,
      quote,
      contentHash,
      anchorStatus,
      start,
      end,
      status: 'open',
      createdBy: input.createdBy,
    }),
    db.insert(comments).values({ id: crypto.randomUUID(), threadId, authorId: input.createdBy, body: input.body }),
  ])
  return { threadId, anchorStatus }
}

/** Append a flat reply to a thread (no nesting) and bump the thread's updatedAt. */
export async function addComment(
  db: DrizzleD1Database,
  input: { threadId: string; authorId: string; body: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.batch([
    db.insert(comments).values({ id, threadId: input.threadId, authorId: input.authorId, body: input.body }),
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
 *  the change resurfaces in the updatedAt-sorted rail. */
export async function deleteComment(db: DrizzleD1Database, threadId: string, commentId: string): Promise<void> {
  const ts = now()
  await db.batch([
    db.update(comments).set({ deletedAt: ts }).where(eq(comments.id, commentId)),
    touchThread(db, threadId, ts),
  ])
}

export async function getComment(db: DrizzleD1Database, commentId: string): Promise<Comment | null> {
  return (await db.select().from(comments).where(eq(comments.id, commentId)).limit(1))[0] ?? null
}

export async function getThread(db: DrizzleD1Database, threadId: string): Promise<CommentThread | null> {
  return (await db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1))[0] ?? null
}
