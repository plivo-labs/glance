import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { CommentFeedItem } from '../db/comment-feed'
import { comments, sites, siteUserShares, spaceMembers, users } from '../db/schema'
import realApp from '../index'
import type { AppEnv } from '../types'
import {
  makeKv,
  seedComment,
  seedGroupShare,
  seedMember,
  seedNotification,
  seedSite,
  seedSpace,
  seedThread,
  seedUserShare,
} from '../test/harness'
import { APP_URL, at, auth, makeRouteApp, mintUser, type RouteApp } from '../test/route-fixtures'

const FEED_URL = '/api/comments/feed'

async function seedGoldenFeed(db: RouteApp['db'], kv: RouteApp['kv']) {
  const userId = await mintUser(db, kv, 'feed-user')
  const actorId = await mintUser(db, kv, 'mention-actor', { email: 'actor@example.com' })
  const spaceId = await seedSpace(db, { id: 'space-feed', createdBy: userId, slug: 'design', name: 'Design' })
  await seedMember(db, spaceId, userId)
  const siteId = await seedSite(db, {
    id: 'site-feed',
    spaceId,
    ownerId: userId,
    slug: 'review',
    title: 'Review Board',
    visibility: 'private',
  })
  const authoredThreadId = await seedThread(db, {
    id: 'thread-authored',
    siteId,
    filePath: 'src/authored.ts',
    status: 'open',
    createdBy: userId,
  })
  await seedComment(db, {
    id: 'comment-authored',
    threadId: authoredThreadId,
    authorId: userId,
    body: 'Authored body',
    createdAt: at(1),
    editedAt: at(2),
  })
  const mentionThreadId = await seedThread(db, {
    id: 'thread-mention',
    siteId,
    filePath: 'src/mention.ts',
    status: 'resolved',
    createdBy: actorId,
  })
  await seedNotification(db, {
    id: 'notification-mention',
    recipientId: userId,
    actorId,
    siteId,
    siteLabel: 'must-not-leak/review',
    threadId: mentionThreadId,
    filePath: 'must-not-leak.ts',
    snippet: 'Please review this.',
    readAt: at(4),
    createdAt: at(3),
  })
  return userId
}

/** Project a feed payload down to `{ kind, id }` for order/identity assertions. */
function kindIds(items: unknown): Array<{ kind: string; id: string }> {
  return (items as CommentFeedItem[]).map(({ kind, id }) => ({ kind, id }))
}

function expectRequestBudget(db: RouteApp['db']) {
  expect(db.counters).toEqual({ loose: 1, batches: 1, batchStmts: 5, insert: 0, update: 0, delete: 0 })
}

describe('comment feed route — C4.1 auth', () => {
  test('anonymous request returns the exact unauthorized response', async () => {
    const { app, env } = makeRouteApp()

    const res = await app.request(FEED_URL, {}, env)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  test('a valid token for a deleted user is rejected before the feed batch', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await mintUser(db, kv, 'deleted-user')
    await db.delete(users).where(eq(users.id, userId))
    db.resetCounters()

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(db.counters.batches).toBe(0)
  })
})

describe('comment feed route — C4.6 root-app composition', () => {
  test('the real app mounts /api/comments/feed', async () => {
    const env = {
      APP_URL,
      CONTENT_URL: 'https://content.example.com',
      GLANCE_DB: {},
      GLANCE_SESSIONS: makeKv(),
    } as unknown as AppEnv['Bindings']

    const res = await realApp.request(FEED_URL, {}, env)

    expect(res.status).toBe(401)
    expect(res.status).not.toBe(404)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })
})

describe('comment feed route — C4.2 golden contract', () => {
  test('returns the exact newest-first authored and mention payload', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await seedGoldenFeed(db, kv)

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        kind: 'mention',
        id: 'notification-mention',
        snippet: 'Please review this.',
        actorName: 'actor@example.com',
        spaceSlug: 'design',
        siteSlug: 'review',
        siteTitle: 'Review Board',
        filePath: 'src/mention.ts',
        threadId: 'thread-mention',
        threadStatus: 'resolved',
        createdAt: '2026-01-01T00:00:03.000Z',
        editedAt: null,
      },
      {
        kind: 'authored',
        id: 'comment-authored',
        snippet: 'Authored body',
        actorName: null,
        spaceSlug: 'design',
        siteSlug: 'review',
        siteTitle: 'Review Board',
        filePath: 'src/authored.ts',
        threadId: 'thread-authored',
        threadStatus: 'open',
        createdAt: '2026-01-01T00:00:01.000Z',
        editedAt: '2026-01-01T00:00:02.000Z',
      },
    ])
  })
})

describe('comment feed route — C4.4 request budget', () => {
  test('a populated feed uses one auth read and one five-statement batch with no writes', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await seedGoldenFeed(db, kv)
    db.resetCounters()

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBe(200)
    expectRequestBudget(db)
  })

  test('an empty feed keeps the same request budget', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await mintUser(db, kv, 'empty-user')
    db.resetCounters()

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expectRequestBudget(db)
  })
})

describe('comment feed route — C4.3 live access transitions', () => {
  test('re-evaluates both feed arms against live grants, membership, site state, and caller role', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const ownerId = await mintUser(db, kv, 'transition-owner')
    const userId = await mintUser(db, kv, 'transition-user')
    const siteSpaceId = await seedSpace(db, {
      id: 'space-transition-site',
      createdBy: ownerId,
      slug: 'transition-site-space',
    })
    const groupSpaceId = await seedSpace(db, {
      id: 'space-transition-group',
      createdBy: ownerId,
      slug: 'transition-group-space',
    })
    const siteId = await seedSite(db, {
      id: 'site-transition',
      spaceId: siteSpaceId,
      ownerId,
      slug: 'transition-site',
      visibility: 'private',
    })
    const authoredThreadId = await seedThread(db, {
      id: 'thread-transition-authored',
      siteId,
      filePath: 'authored.ts',
      createdBy: userId,
    })
    await seedComment(db, {
      id: 'comment-transition-authored',
      threadId: authoredThreadId,
      authorId: userId,
      body: 'Authored during transition',
      createdAt: at(1),
    })
    const mentionThreadId = await seedThread(db, {
      id: 'thread-transition-mention',
      siteId,
      filePath: 'mention.ts',
      createdBy: ownerId,
    })
    await seedNotification(db, {
      id: 'notification-transition-mention',
      recipientId: userId,
      actorId: ownerId,
      siteId,
      threadId: mentionThreadId,
      snippet: 'Mentioned during transition',
      createdAt: at(2),
    })

    const feedIds = async () => {
      const res = await app.request(FEED_URL, { headers: auth(userId) }, env)
      expect(res.status).toBe(200)
      return kindIds(await res.json())
    }
    const bothArms = [
      { kind: 'mention', id: 'notification-transition-mention' },
      { kind: 'authored', id: 'comment-transition-authored' },
    ]
    expect(await feedIds()).toEqual([])

    await seedUserShare(db, siteId, userId)
    expect(await feedIds()).toEqual(bothArms)

    await db
      .delete(siteUserShares)
      .where(and(eq(siteUserShares.siteId, siteId), eq(siteUserShares.userId, userId)))
    expect(await feedIds()).toEqual([])

    await seedGroupShare(db, siteId, groupSpaceId)
    await seedMember(db, groupSpaceId, userId)
    expect(await feedIds()).toEqual(bothArms)

    await db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, groupSpaceId), eq(spaceMembers.userId, userId)))
    expect(await feedIds()).toEqual([])

    await db.update(sites).set({ visibility: 'members' }).where(eq(sites.id, siteId))
    await seedMember(db, siteSpaceId, userId)
    expect(await feedIds()).toEqual(bothArms)

    await db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, siteSpaceId), eq(spaceMembers.userId, userId)))
    expect(await feedIds()).toEqual([])

    await seedUserShare(db, siteId, userId)
    await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, siteId))
    expect(await feedIds()).toEqual([])

    await db.update(users).set({ role: 'superadmin' }).where(eq(users.id, userId))
    expect(await feedIds()).toEqual(bothArms)
  })
})

describe('comment feed route — C4.5 moved site', () => {
  test('uses the current space for both access and response metadata after a move', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const ownerId = await mintUser(db, kv, 'moved-owner')
    const userId = await mintUser(db, kv, 'moved-user')
    const spaceAId = await seedSpace(db, { id: 'space-moved-a', createdBy: ownerId, slug: 'a' })
    const spaceBId = await seedSpace(db, { id: 'space-moved-b', createdBy: ownerId, slug: 'b' })
    await seedMember(db, spaceAId, userId)
    const siteId = await seedSite(db, {
      id: 'site-moved',
      spaceId: spaceAId,
      ownerId,
      slug: 'moved',
      title: 'Moved Site',
      visibility: 'members',
    })
    const authoredThreadId = await seedThread(db, {
      id: 'thread-moved-authored',
      siteId,
      filePath: 'authored.ts',
      createdBy: userId,
      status: 'open',
    })
    await seedComment(db, {
      id: 'comment-moved-authored',
      threadId: authoredThreadId,
      authorId: userId,
      body: 'Authored before the move',
      createdAt: at(1),
    })
    const mentionThreadId = await seedThread(db, {
      id: 'thread-moved-mention',
      siteId,
      filePath: 'mention.ts',
      createdBy: ownerId,
      status: 'resolved',
    })
    await seedNotification(db, {
      id: 'notification-moved-mention',
      recipientId: userId,
      actorId: ownerId,
      siteId,
      siteLabel: 'a/stale-label-must-not-surface',
      threadId: mentionThreadId,
      snippet: 'Mentioned before the move',
      createdAt: at(2),
    })

    const getFeed = async () => {
      const res = await app.request(FEED_URL, { headers: auth(userId) }, env)
      expect(res.status).toBe(200)
      return res.json()
    }
    // The full payload identical before and after the move except for the live space slug.
    const movedFeed = (spaceSlug: string) => [
      {
        kind: 'mention',
        id: 'notification-moved-mention',
        snippet: 'Mentioned before the move',
        actorName: 'moved-owner@example.com',
        spaceSlug,
        siteSlug: 'moved',
        siteTitle: 'Moved Site',
        filePath: 'mention.ts',
        threadId: 'thread-moved-mention',
        threadStatus: 'resolved',
        createdAt: '2026-01-01T00:00:02.000Z',
        editedAt: null,
      },
      {
        kind: 'authored',
        id: 'comment-moved-authored',
        snippet: 'Authored before the move',
        actorName: null,
        spaceSlug,
        siteSlug: 'moved',
        siteTitle: 'Moved Site',
        filePath: 'authored.ts',
        threadId: 'thread-moved-authored',
        threadStatus: 'open',
        createdAt: '2026-01-01T00:00:01.000Z',
        editedAt: null,
      },
    ]
    expect(await getFeed()).toEqual(movedFeed('a'))

    await db.update(sites).set({ spaceId: spaceBId }).where(eq(sites.id, siteId))
    expect(await getFeed()).toEqual([])

    await seedMember(db, spaceBId, userId)
    expect(await getFeed()).toEqual(movedFeed('b'))
  })
})

describe('comment feed route — C4.7 caller isolation', () => {
  test("returns only the caller's authored comments and mention notifications", async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await mintUser(db, kv, 'isolation-me')
    const otherUserId = await mintUser(db, kv, 'isolation-other')
    const spaceId = await seedSpace(db, { id: 'space-isolation', createdBy: userId, slug: 'isolation' })
    const siteId = await seedSite(db, {
      id: 'site-isolation',
      spaceId,
      ownerId: userId,
      slug: 'team-site',
      visibility: 'team',
    })
    const myAuthoredThreadId = await seedThread(db, {
      id: 'thread-isolation-my-authored',
      siteId,
      filePath: 'my-authored.ts',
      createdBy: userId,
    })
    await seedComment(db, {
      id: 'comment-isolation-my-authored',
      threadId: myAuthoredThreadId,
      authorId: userId,
      body: 'My authored comment',
      createdAt: at(1),
    })
    const myMentionThreadId = await seedThread(db, {
      id: 'thread-isolation-my-mention',
      siteId,
      filePath: 'my-mention.ts',
      createdBy: otherUserId,
    })
    await seedNotification(db, {
      id: 'notification-isolation-my-mention',
      recipientId: userId,
      actorId: otherUserId,
      siteId,
      threadId: myMentionThreadId,
      snippet: 'My mention',
      createdAt: at(2),
    })
    const otherAuthoredThreadId = await seedThread(db, {
      id: 'thread-isolation-other-authored',
      siteId,
      filePath: 'other-authored.ts',
      createdBy: otherUserId,
    })
    await seedComment(db, {
      id: 'comment-isolation-other-authored',
      threadId: otherAuthoredThreadId,
      authorId: otherUserId,
      body: 'Other newer authored comment',
      createdAt: at(3),
    })
    const otherMentionThreadId = await seedThread(db, {
      id: 'thread-isolation-other-mention',
      siteId,
      filePath: 'other-mention.ts',
      createdBy: userId,
    })
    await seedNotification(db, {
      id: 'notification-isolation-other-mention',
      recipientId: otherUserId,
      actorId: userId,
      siteId,
      threadId: otherMentionThreadId,
      snippet: 'Other newer mention',
      createdAt: at(4),
    })

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBe(200)
    expect(kindIds(await res.json())).toEqual([
      { kind: 'mention', id: 'notification-isolation-my-mention' },
      { kind: 'authored', id: 'comment-isolation-my-authored' },
    ])
  })
})

describe('comment feed route — C4.8 mention read state', () => {
  test('returns both read and unread mention notifications', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await mintUser(db, kv, 'read-state-user')
    const actorId = await mintUser(db, kv, 'read-state-actor')
    const spaceId = await seedSpace(db, { id: 'space-read-state', createdBy: userId, slug: 'read-state' })
    const siteId = await seedSite(db, {
      id: 'site-read-state',
      spaceId,
      ownerId: userId,
      slug: 'read-state-site',
      visibility: 'private',
    })
    const unreadThreadId = await seedThread(db, {
      id: 'thread-unread-mention',
      siteId,
      filePath: 'unread.ts',
      createdBy: actorId,
    })
    await seedNotification(db, {
      id: 'notification-unread-mention',
      recipientId: userId,
      actorId,
      siteId,
      threadId: unreadThreadId,
      snippet: 'Unread mention',
      readAt: null,
      createdAt: at(1),
    })
    const readThreadId = await seedThread(db, {
      id: 'thread-read-mention',
      siteId,
      filePath: 'read.ts',
      createdBy: actorId,
    })
    await seedNotification(db, {
      id: 'notification-read-mention',
      recipientId: userId,
      actorId,
      siteId,
      threadId: readThreadId,
      snippet: 'Read mention',
      readAt: at(3),
      createdAt: at(2),
    })

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBe(200)
    expect(kindIds(await res.json())).toEqual([
      { kind: 'mention', id: 'notification-read-mention' },
      { kind: 'mention', id: 'notification-unread-mention' },
    ])
  })
})

describe('comment feed route — C4.10 batch failure', () => {
  test('returns a 5xx response instead of an empty successful feed when the batch rejects', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await mintUser(db, kv, 'batch-failure-user')
    db.batch = (() => Promise.reject(new Error('d1 down'))) as typeof db.batch

    const res = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await res.text()).not.toEqual('[]')
  })
})

describe('comment feed route — C4.9 scan-cap hole', () => {
  test('does not backfill an accessible authored row beyond the 200-candidate window', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const userId = await mintUser(db, kv, 'scan-cap-user')
    const otherUserId = await mintUser(db, kv, 'scan-cap-owner')
    const ownSpaceId = await seedSpace(db, { id: 'space-scan-cap-own', createdBy: userId, slug: 'scan-cap-own' })
    const ownSiteId = await seedSite(db, {
      id: 'site-scan-cap-own',
      spaceId: ownSpaceId,
      ownerId: userId,
      slug: 'own-site',
      visibility: 'private',
    })
    const ownThreadId = await seedThread(db, {
      id: 'thread-scan-cap-own',
      siteId: ownSiteId,
      filePath: 'old.ts',
      createdBy: userId,
    })
    await seedComment(db, {
      id: 'comment-scan-cap-old-accessible',
      threadId: ownThreadId,
      authorId: userId,
      body: 'Old accessible comment',
      createdAt: at(0),
    })
    const privateSpaceId = await seedSpace(db, {
      id: 'space-scan-cap-private',
      createdBy: otherUserId,
      slug: 'scan-cap-private',
    })
    const privateSiteId = await seedSite(db, {
      id: 'site-scan-cap-private',
      spaceId: privateSpaceId,
      ownerId: otherUserId,
      slug: 'private-site',
      visibility: 'private',
    })
    const privateThreadId = await seedThread(db, {
      id: 'thread-scan-cap-private',
      siteId: privateSiteId,
      filePath: 'private.ts',
      createdBy: userId,
    })
    for (let i = 1; i <= 200; i++) {
      await seedComment(db, {
        id: `comment-scan-cap-private-${i.toString().padStart(3, '0')}`,
        threadId: privateThreadId,
        authorId: userId,
        body: `Newer inaccessible comment ${i}`,
        createdAt: at(i),
      })
    }

    const first = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([])

    await db
      .update(comments)
      .set({ deletedAt: at(201) })
      .where(eq(comments.id, 'comment-scan-cap-private-200'))
    const second = await app.request(FEED_URL, { headers: auth(userId) }, env)

    expect(second.status).toBe(200)
    expect(kindIds(await second.json())).toEqual([{ kind: 'authored', id: 'comment-scan-cap-old-accessible' }])
  })
})
