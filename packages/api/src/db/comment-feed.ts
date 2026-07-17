import { and, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { checkAccess } from '../lib/access'
import type { SessionUser } from '../types'
import {
  comments,
  commentThreads,
  notifications,
  sites,
  spaces,
  users,
  type ThreadStatus,
  type Visibility,
} from './schema'

type SiteStatus = (typeof sites.$inferSelect)['status']

// Access filtering runs AFTER this newest-per-arm window, so a user whose newest 200
// candidates are inaccessible sees an under-filled feed (accepted contract, pinned later
// by route case C4.9; fix would be a bigger cap, never cursors).
// The owned arm cannot walk an index for its ORDER BY because sites.ownerId is two joins away,
// so it fully materializes and sorts its matches. Escape hatches are denormalizing ownerId onto
// comments or adding a per-site cap.
const FEED_SCAN_WINDOW = 200
const FEED_LIMIT = 50
const FEED_SNIPPET_LENGTH = 200

// Thread/site/space columns shared by all candidate arms. Every column is aliased with .as() —
// D1 batch results map by result-column NAME, so unaliased join columns would silently collide.
const THREAD_SITE_COLUMNS = {
  threadId: sql<string>`${commentThreads.id}`.as('threadId'),
  threadStatus: sql<ThreadStatus>`${commentThreads.status}`.as('threadStatus'),
  filePath: sql<string>`${commentThreads.filePath}`.as('filePath'),
  siteId: sql<string>`${sites.id}`.as('siteId'),
  siteSlug: sql<string>`${sites.slug}`.as('siteSlug'),
  siteTitle: sql<string | null>`${sites.title}`.as('siteTitle'),
  visibility: sql<Visibility>`${sites.visibility}`.as('visibility'),
  siteStatus: sql<SiteStatus>`${sites.status}`.as('siteStatus'),
  ownerId: sql<string>`${sites.ownerId}`.as('ownerId'),
  spaceId: sql<string>`${spaces.id}`.as('spaceId'),
  spaceSlug: sql<string>`${spaces.slug}`.as('spaceSlug'),
}

const commentsRowid = sql<number>`"comments".rowid`
const notificationsRowid = sql<number>`"notifications".rowid`

function commentCandidatesStmt(db: DrizzleD1Database, where: SQL | undefined) {
  return db
    .select({
      commentId: sql<string>`${comments.id}`.as('commentId'),
      body: sql<string>`${comments.body}`.as('body'),
      createdAt: sql<string>`${comments.createdAt}`.as('createdAt'),
      editedAt: sql<string | null>`${comments.editedAt}`.as('editedAt'),
      rowid: commentsRowid.as('rowid'),
      actorName: sql<string | null>`${users.name}`.as('actorName'),
      actorEmail: sql<string | null>`${users.email}`.as('actorEmail'),
      ...THREAD_SITE_COLUMNS,
    })
    .from(comments)
    .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
    .innerJoin(sites, eq(commentThreads.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(where)
    .orderBy(desc(comments.createdAt), desc(commentsRowid))
    .limit(FEED_SCAN_WINDOW)
}

export function authoredCandidatesStmt(db: DrizzleD1Database, userId: string) {
  return commentCandidatesStmt(db, and(eq(comments.authorId, userId), isNull(comments.deletedAt)))
}

export function ownedCandidatesStmt(db: DrizzleD1Database, userId: string) {
  return commentCandidatesStmt(
    db,
    and(
      eq(sites.ownerId, userId),
      isNull(comments.deletedAt),
      or(isNull(comments.authorId), ne(comments.authorId, userId)),
    ),
  )
}

export function mentionCandidatesStmt(db: DrizzleD1Database, userId: string) {
  return db
    .select({
      id: sql<string>`${notifications.id}`.as('id'),
      commentId: sql<string | null>`${notifications.commentId}`.as('commentId'),
      snippet: sql<string | null>`${notifications.snippet}`.as('snippet'),
      createdAt: sql<string>`${notifications.createdAt}`.as('createdAt'),
      rowid: notificationsRowid.as('rowid'),
      actorName: sql<string | null>`${users.name}`.as('actorName'),
      actorEmail: sql<string | null>`${users.email}`.as('actorEmail'),
      ...THREAD_SITE_COLUMNS,
    })
    .from(notifications)
    .innerJoin(commentThreads, eq(notifications.threadId, commentThreads.id))
    .innerJoin(sites, eq(commentThreads.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .leftJoin(users, eq(notifications.actorId, users.id))
    .where(and(eq(notifications.recipientId, userId), eq(notifications.type, 'mention')))
    .orderBy(desc(notifications.createdAt), desc(notificationsRowid))
    .limit(FEED_SCAN_WINDOW)
}

export type CommentCandidateRow = Awaited<ReturnType<typeof authoredCandidatesStmt>>[number]
export type MentionCandidateRow = Awaited<ReturnType<typeof mentionCandidatesStmt>>[number]

export type CommentFeedItem = {
  kind: 'mention' | 'authored' | 'owned'
  id: string
  snippet: string | null
  actorName: string | null
  spaceSlug: string
  siteSlug: string
  siteTitle: string | null
  filePath: string
  threadId: string
  threadStatus: ThreadStatus
  createdAt: string
  editedAt: string | null
}

type FeedCandidate =
  | { kind: 'mention'; row: MentionCandidateRow }
  | { kind: 'authored' | 'owned'; row: CommentCandidateRow }

const KIND_RANK = { mention: 0, authored: 1, owned: 2 } as const

export function truncateSnippet(body: string): string {
  const s = body.slice(0, FEED_SNIPPET_LENGTH)
  return s.length === FEED_SNIPPET_LENGTH && /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s
}

function compareFeedCandidates(a: FeedCandidate, b: FeedCandidate): number {
  return (
    b.row.createdAt.localeCompare(a.row.createdAt) ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    b.row.rowid - a.row.rowid
  )
}

function toCommentFeedItem(candidate: FeedCandidate): CommentFeedItem {
  const { row } = candidate
  const common = {
    spaceSlug: row.spaceSlug,
    siteSlug: row.siteSlug,
    siteTitle: row.siteTitle,
    filePath: row.filePath,
    threadId: row.threadId,
    threadStatus: row.threadStatus,
    createdAt: row.createdAt,
  }
  if (candidate.kind === 'mention') {
    return {
      kind: 'mention',
      id: candidate.row.id,
      ...common,
      snippet: candidate.row.snippet,
      actorName: candidate.row.actorName ?? candidate.row.actorEmail,
      editedAt: null,
    }
  }
  return {
    kind: candidate.kind,
    id: candidate.row.commentId,
    ...common,
    snippet: truncateSnippet(candidate.row.body),
    actorName: candidate.kind === 'owned' ? (candidate.row.actorName ?? candidate.row.actorEmail) : null,
    editedAt: candidate.row.editedAt,
  }
}

export function assembleCommentFeed(input: {
  authored: CommentCandidateRow[]
  mentions: MentionCandidateRow[]
  owned: CommentCandidateRow[]
  user: SessionUser
  memberSpaceIds: Set<string>
  sharedSiteRoles: { has(siteId: string): boolean }
}): CommentFeedItem[] {
  // Legacy mention rows have a null commentId, which can never match an owned comment's id.
  const mentionedCommentIds = new Set(input.mentions.map((row) => row.commentId))
  const owned = input.owned.filter((row) => !mentionedCommentIds.has(row.commentId))

  return [
    ...input.mentions.map((row) => ({ kind: 'mention' as const, row })),
    ...input.authored.map((row) => ({ kind: 'authored' as const, row })),
    ...owned.map((row) => ({ kind: 'owned' as const, row })),
  ]
    .filter(({ row }) =>
      checkAccess(
        { visibility: row.visibility, status: row.siteStatus, ownerId: row.ownerId },
        input.user,
        input.memberSpaceIds.has(row.spaceId),
        input.sharedSiteRoles.has(row.siteId),
      ).ok,
    )
    .sort(compareFeedCandidates)
    .slice(0, FEED_LIMIT)
    .map(toCommentFeedItem)
}
