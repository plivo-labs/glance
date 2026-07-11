// Comments-feed DB layer specs. C1.1 pins migration 0012: the single-column
// comments_author index is replaced by (authorId, deletedAt, createdAt) so the
// authored-arm feed scan (deletedAt IS NULL ORDER BY createdAt DESC) is covered.
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../types'
import {
  makeDb,
  seedComment,
  seedMember,
  seedNotification,
  seedSite,
  seedSpace,
  seedThread,
  seedUser,
} from '../test/harness'
import {
  assembleCommentFeed,
  authoredCandidatesStmt,
  type AuthoredCandidateRow,
  mentionCandidatesStmt,
  type MentionCandidateRow,
} from './comment-feed'
import { foldSharedSiteRoles } from './repo'

describe('migration 0012 — comments author index', () => {
  test('C1.1 comments_author_deleted_created has exactly (authorId, deletedAt, createdAt); comments_author is gone', async () => {
    const db = makeDb()
    const cols = await db.all(
      sql`SELECT name FROM pragma_index_info('comments_author_deleted_created') ORDER BY seqno`,
    )
    expect(cols).toEqual([{ name: 'authorId' }, { name: 'deletedAt' }, { name: 'createdAt' }])
    const old = await db.all(sql`SELECT name FROM pragma_index_list('comments') WHERE name = 'comments_author'`)
    expect(old).toEqual([])
  })
})

describe('comments feed candidate statements', () => {
  test('C2.1 authored and mention candidates carry their space and site slugs through one batch', async () => {
    const db = makeDb()
    const userId = await seedUser(db)
    const spaceA = await seedSpace(db, { createdBy: userId, slug: 'space-a' })
    const spaceB = await seedSpace(db, { createdBy: userId, slug: 'space-b' })
    await seedMember(db, spaceA, userId)
    await seedMember(db, spaceB, userId)
    const siteA = await seedSite(db, { spaceId: spaceA, ownerId: userId, slug: 'site-a' })
    const siteB = await seedSite(db, { spaceId: spaceB, ownerId: userId, slug: 'site-b' })
    const threadA = await seedThread(db, { siteId: siteA, filePath: 'a.html' })
    const threadB = await seedThread(db, { siteId: siteB, filePath: 'b.html' })
    await seedComment(db, { threadId: threadA, authorId: userId })
    await seedComment(db, { threadId: threadB, authorId: userId })
    await seedNotification(db, { recipientId: userId, threadId: threadA, siteId: siteA })
    await seedNotification(db, { recipientId: userId, threadId: threadB, siteId: siteB })

    const [authored, mentioned] = await db.batch([
      authoredCandidatesStmt(db, userId),
      mentionCandidatesStmt(db, userId),
    ])

    expect(authored.map((row) => [row.spaceSlug, row.siteSlug]).sort()).toEqual([
      ['space-a', 'site-a'],
      ['space-b', 'site-b'],
    ])
    expect(mentioned.map((row) => [row.spaceSlug, row.siteSlug]).sort()).toEqual([
      ['space-a', 'site-a'],
      ['space-b', 'site-b'],
    ])
  })

  test('C2.2 authored candidates exclude a soft-deleted comment beside a live timestamp tie', async () => {
    const db = makeDb()
    const userId = await seedUser(db)
    const spaceId = await seedSpace(db, { createdBy: userId })
    await seedMember(db, spaceId, userId)
    const siteId = await seedSite(db, { spaceId, ownerId: userId })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html' })
    const createdAt = '2026-07-11T10:00:00.000Z'
    const liveId = await seedComment(db, { threadId, authorId: userId, createdAt })
    await seedComment(db, {
      threadId,
      authorId: userId,
      createdAt,
      deletedAt: '2026-07-11T10:01:00.000Z',
    })

    const [authored] = await db.batch([authoredCandidatesStmt(db, userId)])

    expect(authored.map((row) => row.id)).toEqual([liveId])
  })

  test('C2.3 mention candidates preserve named, email-only, and deleted actor states', async () => {
    const db = makeDb()
    const userId = await seedUser(db)
    const namedActorId = await seedUser(db, { email: 'named@example.com', name: 'Named Actor' })
    const emailActorId = await seedUser(db, { email: 'email-only@example.com', name: null })
    const spaceId = await seedSpace(db, { createdBy: userId })
    await seedMember(db, spaceId, userId)
    const siteId = await seedSite(db, { spaceId, ownerId: userId })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html' })
    const namedNotificationId = await seedNotification(db, {
      recipientId: userId,
      actorId: namedActorId,
      siteId,
      threadId,
    })
    const emailNotificationId = await seedNotification(db, {
      recipientId: userId,
      actorId: emailActorId,
      siteId,
      threadId,
    })
    const deletedNotificationId = await seedNotification(db, {
      recipientId: userId,
      actorId: null,
      siteId,
      threadId,
    })

    const [mentioned] = await db.batch([mentionCandidatesStmt(db, userId)])

    expect(mentioned.map((row) => [row.id, row.actorName, row.actorEmail]).sort()).toEqual(
      [
        [namedNotificationId, 'Named Actor', 'named@example.com'],
        [emailNotificationId, null, 'email-only@example.com'],
        [deletedNotificationId, null, null],
      ].sort(),
    )
  })

  test('C2.4 mention candidates require a thread and derive the site only from that thread', async () => {
    const db = makeDb()
    const userId = await seedUser(db)
    const ownerX = await seedUser(db)
    const ownerY = await seedUser(db)
    const spaceX = await seedSpace(db, { createdBy: ownerX, slug: 'space-x' })
    const spaceY = await seedSpace(db, { createdBy: ownerY, slug: 'space-y' })
    await seedMember(db, spaceX, userId)
    await seedMember(db, spaceY, userId)
    const siteX = await seedSite(db, { spaceId: spaceX, ownerId: ownerX, slug: 'site-x' })
    const siteY = await seedSite(db, { spaceId: spaceY, ownerId: ownerY, slug: 'site-y' })
    const threadY = await seedThread(db, { siteId: siteY, filePath: 'y.html' })
    const orphanId = await seedNotification(db, { recipientId: userId, threadId: null, siteId: siteX })
    const validId = await seedNotification(db, { recipientId: userId, threadId: threadY, siteId: siteY })
    const mismatchedSiteId = await seedNotification(db, {
      recipientId: userId,
      threadId: threadY,
      siteId: siteX,
    })
    const nullSiteId = await seedNotification(db, { recipientId: userId, threadId: threadY, siteId: null })

    const [mentioned] = await db.batch([mentionCandidatesStmt(db, userId)])

    expect(mentioned.map((row) => [row.id, row.siteSlug, row.ownerId]).sort()).toEqual(
      [
        [validId, 'site-y', ownerY],
        [mismatchedSiteId, 'site-y', ownerY],
        [nullSiteId, 'site-y', ownerY],
      ].sort(),
    )
    expect(mentioned.some((row) => row.id === orphanId)).toBe(false)
  })

  test('C2.6 per-arm scan window keeps exactly the newest 200 of 205, rowid breaking timestamp ties', async () => {
    const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString()
    const createdAtFor = (n: number) => (n === 200 || n === 201 || n === 202 ? ts(200) : ts(n))
    type Seeded = { n: number; id: string; createdAt: string; insertionIndex: number }
    const expectedIds = (seeded: Seeded[]) =>
      [...seeded]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.insertionIndex - a.insertionIndex)
        .slice(0, 200)
        .map((r) => r.id)

    const db = makeDb()
    const userId = await seedUser(db)
    const spaceId = await seedSpace(db, { createdBy: userId })
    await seedMember(db, spaceId, userId)
    const siteId = await seedSite(db, { spaceId, ownerId: userId })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html' })

    const authoredByN = new Map<number, string>()
    const authoredSeeded: Seeded[] = []
    for (let i = 0; i < 205; i++) {
      const n = (i * 97) % 205
      const createdAt = createdAtFor(n)
      const id = await seedComment(db, { threadId, authorId: userId, createdAt })
      authoredByN.set(n, id)
      authoredSeeded.push({ n, id, createdAt, insertionIndex: i })
    }

    const [authoredRows] = await db.batch([authoredCandidatesStmt(db, userId)])
    expect(authoredRows.length).toBe(200)
    for (let n = 0; n < 5; n++) {
      expect(authoredRows.some((row) => row.id === authoredByN.get(n))).toBe(false)
    }
    expect(authoredRows.map((row) => row.id)).toEqual(expectedIds(authoredSeeded))

    const mentionByN = new Map<number, string>()
    const mentionSeeded: Seeded[] = []
    for (let i = 0; i < 205; i++) {
      const n = (i * 97) % 205
      const createdAt = createdAtFor(n)
      const id = await seedNotification(db, {
        recipientId: userId,
        threadId,
        siteId,
        snippet: `mention-${n}`,
        createdAt,
      })
      mentionByN.set(n, id)
      mentionSeeded.push({ n, id, createdAt, insertionIndex: i })
    }

    const [mentionRows] = await db.batch([mentionCandidatesStmt(db, userId)])
    expect(mentionRows.length).toBe(200)
    for (let n = 0; n < 5; n++) {
      expect(mentionRows.some((row) => row.id === mentionByN.get(n))).toBe(false)
    }
    expect(mentionRows.map((row) => row.id)).toEqual(expectedIds(mentionSeeded))
  })
})

function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    role: 'member',
    ...overrides,
  }
}

function authoredRow(overrides: Partial<AuthoredCandidateRow> = {}): AuthoredCandidateRow {
  return {
    id: 'authored-1',
    body: 'Authored comment',
    createdAt: '2026-07-11T10:00:00.000Z',
    editedAt: null,
    rowid: 1,
    threadId: 'thread-1',
    threadStatus: 'open',
    filePath: 'index.html',
    siteId: 'site-1',
    siteSlug: 'site',
    siteTitle: 'Site',
    visibility: 'private',
    siteStatus: 'active',
    ownerId: 'user-1',
    spaceId: 'space-1',
    spaceSlug: 'space',
    ...overrides,
  }
}

function mentionRow(overrides: Partial<MentionCandidateRow> = {}): MentionCandidateRow {
  return {
    id: 'mention-1',
    snippet: 'Mention snapshot',
    createdAt: '2026-07-11T10:00:00.000Z',
    rowid: 1,
    actorName: 'Mentioner',
    actorEmail: 'mentioner@example.com',
    threadId: 'thread-1',
    threadStatus: 'open',
    filePath: 'index.html',
    siteId: 'site-1',
    siteSlug: 'site',
    siteTitle: 'Site',
    visibility: 'private',
    siteStatus: 'active',
    ownerId: 'user-1',
    spaceId: 'space-1',
    spaceSlug: 'space',
    ...overrides,
  }
}

describe('assembleCommentFeed', () => {
  test('C3.1 merges candidates by timestamp, kind rank, then same-kind rowid', () => {
    const result = assembleCommentFeed({
      authored: [
        authoredRow({ id: 'authored-tie-low', createdAt: '2026-07-11T11:00:00.000Z', rowid: 3 }),
        authoredRow({ id: 'authored-kind-tie', createdAt: '2026-07-11T12:00:00.000Z', rowid: 99 }),
        authoredRow({ id: 'authored-oldest', createdAt: '2026-07-11T10:00:00.000Z', rowid: 100 }),
        authoredRow({ id: 'authored-tie-high', createdAt: '2026-07-11T11:00:00.000Z', rowid: 8 }),
      ],
      mentions: [
        mentionRow({ id: 'mention-newest', createdAt: '2026-07-11T13:00:00.000Z', rowid: 1 }),
        mentionRow({ id: 'mention-kind-tie', createdAt: '2026-07-11T12:00:00.000Z', rowid: 1 }),
      ],
      user: makeUser(),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })

    expect(result.map((row) => row.id)).toEqual([
      'mention-newest',
      'mention-kind-tie',
      'authored-kind-tie',
      'authored-tie-high',
      'authored-tie-low',
      'authored-oldest',
    ])
  })

  test('C3.2 folds membership and shared-site facts through the access oracle', () => {
    const groupRoles = foldSharedSiteRoles([], [{ siteId: 'site-private-group' }])
    const directRoles = foldSharedSiteRoles(
      [
        { siteId: 'site-private-direct', role: 'editor' },
        { siteId: 'site-archived-granted', role: 'viewer' },
      ],
      [],
    )
    const plainUserResult = assembleCommentFeed({
      authored: [
        authoredRow({
          id: 'members-member',
          siteId: 'site-members-keep',
          spaceId: 'space-member',
          visibility: 'members',
          ownerId: 'someone-else',
        }),
        authoredRow({
          id: 'private-group',
          siteId: 'site-private-group',
          visibility: 'private',
          ownerId: 'someone-else',
        }),
        authoredRow({
          id: 'private-no-grant',
          siteId: 'site-private-none',
          visibility: 'private',
          ownerId: 'someone-else',
        }),
      ],
      mentions: [
        mentionRow({
          id: 'members-non-member',
          siteId: 'site-members-drop',
          spaceId: 'space-non-member',
          visibility: 'members',
          ownerId: 'someone-else',
        }),
        mentionRow({
          id: 'private-direct',
          siteId: 'site-private-direct',
          visibility: 'private',
          ownerId: 'someone-else',
        }),
        mentionRow({
          id: 'archived-plain-with-grant',
          siteId: 'site-archived-granted',
          visibility: 'private',
          siteStatus: 'archived',
          ownerId: 'someone-else',
        }),
      ],
      user: makeUser(),
      memberSpaceIds: new Set(['space-member']),
      sharedSiteRoles: new Map([...groupRoles, ...directRoles]),
    })
    const superadminResult = assembleCommentFeed({
      authored: [
        authoredRow({
          id: 'archived-superadmin',
          siteId: 'site-archived-superadmin',
          visibility: 'private',
          siteStatus: 'archived',
          ownerId: 'someone-else',
        }),
      ],
      mentions: [],
      user: makeUser({ role: 'superadmin' }),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })

    expect([...plainUserResult, ...superadminResult].map((row) => row.id).sort()).toEqual([
      'archived-superadmin',
      'members-member',
      'private-direct',
      'private-group',
    ])
  })

  test('C3.3 limits the feed to the newest 50 with rowid breaking the boundary tie', () => {
    const shuffledRanks = Array.from({ length: 60 }, (_, index) => ((index * 17) % 60) + 1)
    const distinctRows = shuffledRanks.map((rank) =>
      authoredRow({
        id: `authored-${String(rank).padStart(2, '0')}`,
        createdAt: `2026-07-11T10:${String(rank - 1).padStart(2, '0')}:00.000Z`,
        rowid: rank,
      }),
    )
    // Plain descending id sequence (60, 59, …) — ranks 11-60 need no zero padding.
    const authoredIdsDescFrom60 = (count: number) =>
      Array.from({ length: count }, (_, index) => `authored-${60 - index}`)
    const expectedNewest = authoredIdsDescFrom60(50)

    const distinctResult = assembleCommentFeed({
      authored: distinctRows,
      mentions: [],
      user: makeUser(),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })

    expect(distinctResult.map((row) => row.id)).toEqual(expectedNewest)

    const boundaryRows = distinctRows.map((row) => {
      if (row.id === 'authored-10') {
        return { ...row, id: 'boundary-high', createdAt: '2026-07-11T10:10:00.000Z', rowid: 900 }
      }
      if (row.id === 'authored-11') {
        return { ...row, id: 'boundary-low', createdAt: '2026-07-11T10:10:00.000Z', rowid: 100 }
      }
      return row
    })
    // authored-60 … authored-12, then boundary-high wins the 10:10 tie on rowid.
    const expectedBoundary = [...authoredIdsDescFrom60(49), 'boundary-high']

    const boundaryResult = assembleCommentFeed({
      authored: boundaryRows,
      mentions: [],
      user: makeUser(),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })

    expect(boundaryResult.map((row) => row.id)).toEqual(expectedBoundary)
  })

  test('C3.4 maps authored and mention candidates to exact public payloads', () => {
    const authoredBody = 'x'.repeat(201)
    const [authored] = assembleCommentFeed({
      authored: [
        authoredRow({
          id: 'authored-payload',
          body: authoredBody,
          createdAt: '2026-07-11T14:00:00.000Z',
          editedAt: '2026-07-11T14:05:00.000Z',
          threadId: 'thread-authored',
          threadStatus: 'resolved',
          filePath: 'docs/authored.html',
          siteId: 'internal-authored-site-id',
          siteSlug: 'authored-site',
          siteTitle: null,
          spaceId: 'internal-authored-space-id',
          spaceSlug: 'authored-space',
          rowid: 77,
        }),
      ],
      mentions: [],
      user: makeUser(),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })

    expect(authored).toEqual({
      kind: 'authored',
      id: 'authored-payload',
      snippet: 'x'.repeat(200),
      actorName: null,
      spaceSlug: 'authored-space',
      siteSlug: 'authored-site',
      siteTitle: null,
      filePath: 'docs/authored.html',
      threadId: 'thread-authored',
      threadStatus: 'resolved',
      createdAt: '2026-07-11T14:00:00.000Z',
      editedAt: '2026-07-11T14:05:00.000Z',
    })

    for (const body of ['y'.repeat(199), 'z'.repeat(200)]) {
      const [item] = assembleCommentFeed({
        authored: [authoredRow({ body })],
        mentions: [],
        user: makeUser(),
        memberSpaceIds: new Set(),
        sharedSiteRoles: new Map(),
      })
      expect(item?.snippet).toBe(body)
    }

    const surrogateBody = `${'x'.repeat(199)}\u{1F600}`
    const [surrogateItem] = assembleCommentFeed({
      authored: [authoredRow({ body: surrogateBody })],
      mentions: [],
      user: makeUser(),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })
    expect(surrogateItem?.snippet?.length).toBe(199)
    expect(surrogateItem?.snippet).toBe('x'.repeat(199))

    // The notification snippet is a write-time snapshot: editing or deleting its source comment
    // later does not change the feed payload.
    const [mention] = assembleCommentFeed({
      authored: [],
      mentions: [
        mentionRow({
          id: 'mention-payload',
          snippet: 'Stored mention snapshot',
          actorName: 'Ada Mentioner',
          actorEmail: 'ignored@example.com',
          createdAt: '2026-07-11T15:00:00.000Z',
          threadId: 'thread-mention',
          threadStatus: 'open',
          filePath: 'docs/mention.html',
          siteId: 'internal-mention-site-id',
          siteSlug: 'mention-site',
          siteTitle: 'Mention Site',
          spaceId: 'internal-mention-space-id',
          spaceSlug: 'mention-space',
          rowid: 88,
        }),
      ],
      user: makeUser(),
      memberSpaceIds: new Set(),
      sharedSiteRoles: new Map(),
    })

    expect(mention).toEqual({
      kind: 'mention',
      id: 'mention-payload',
      snippet: 'Stored mention snapshot',
      actorName: 'Ada Mentioner',
      spaceSlug: 'mention-space',
      siteSlug: 'mention-site',
      siteTitle: 'Mention Site',
      filePath: 'docs/mention.html',
      threadId: 'thread-mention',
      threadStatus: 'open',
      createdAt: '2026-07-11T15:00:00.000Z',
      editedAt: null,
    })
  })
})
