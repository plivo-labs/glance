import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { commentReactions, users } from '../db/schema'
import { seedComment, seedMember, seedSite, seedSpace, seedThread } from '../test/harness'
import { auth, makeRouteApp, mintUser, type RouteApp } from '../test/route-fixtures'

// Emoji reactions on a comment — PUT/DELETE …/comments/:threadId/messages/:commentId/reactions,
// plus the fold that rides the GET list's existing batch. The routes add NO access rule of their
// own: they run the SAME gate the sibling message routes run (siteWithUrlComment), so reacting
// needs exactly what commenting needs. Both verbs are no-op-safe and answer with the comment's
// whole reaction set, so a double-click (or a lost response) converges instead of erroring.

const url = (threadId: string, commentId: string) =>
  `/api/sites/acme/doc/comments/${threadId}/messages/${commentId}/reactions`

/** Seed acme/doc owned by `ownerId` with one thread + opening comment (the reaction target). */
async function seedCommentedSite(
  db: RouteApp['db'],
  ownerId: string,
  visibility: 'private' | 'members' | 'team' = 'team',
) {
  const spaceId = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
  const siteId = await seedSite(db, { spaceId, ownerId, slug: 'doc', visibility })
  const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: ownerId })
  const commentId = await seedComment(db, { threadId, authorId: ownerId, body: 'opening' })
  return { spaceId, siteId, threadId, commentId }
}

/** App + acme/doc + a signed-in owner and a signed-in member of the space. */
async function setup(visibility: 'private' | 'members' | 'team' = 'team') {
  const ctx = makeRouteApp()
  const owner = await mintUser(ctx.db, ctx.kv, 'owner')
  const member = await mintUser(ctx.db, ctx.kv, 'member')
  const seeded = await seedCommentedSite(ctx.db, owner, visibility)
  await seedMember(ctx.db, seeded.spaceId, member)
  return { ...ctx, owner, member, ...seeded }
}

const react = (
  ctx: RouteApp,
  who: string,
  ids: { threadId: string; commentId: string },
  body: unknown,
  method: 'PUT' | 'DELETE' = 'PUT',
) =>
  ctx.app.request(url(ids.threadId, ids.commentId), { method, headers: auth(who), body: JSON.stringify(body) }, ctx.env)

const list = async (ctx: RouteApp, who: string, extra = '?filePath=index.html') => {
  const res = await ctx.app.request(`/api/sites/acme/doc/comments${extra}`, { headers: auth(who) }, ctx.env)
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{ comments: Array<{ id: string; reactions: unknown }> }>
}

describe('PUT/DELETE comment reactions — the toggle', () => {
  test('adding returns the comment’s whole set, and adding the SAME emoji twice stays one row', async () => {
    const ctx = await setup()
    const first = await react(ctx, 'member', ctx, { emoji: '🔥' })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([{ emoji: '🔥', count: 1, mine: true, names: [] }])

    const again = await react(ctx, 'member', ctx, { emoji: '🔥' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual([{ emoji: '🔥', count: 1, mine: true, names: [] }])
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(1)
  })

  test('removing returns the fresh set, and removing what was never there is still 200', async () => {
    const ctx = await setup()
    await react(ctx, 'member', ctx, { emoji: '🔥' })

    const removed = await react(ctx, 'member', ctx, { emoji: '🔥' }, 'DELETE')
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual([])
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(0)

    const noop = await react(ctx, 'member', ctx, { emoji: '🔥' }, 'DELETE')
    expect(noop.status).toBe(200)
    expect(await noop.json()).toEqual([])
  })

  test('one user may hold SEVERAL distinct emojis, and a remove takes only the one named', async () => {
    const ctx = await setup()
    await react(ctx, 'member', ctx, { emoji: '🔥' })
    const two = await react(ctx, 'member', ctx, { emoji: '🎉' })
    // Order is first-reacted-first — the set is stable across polls, not re-sorted by count.
    expect(await two.json()).toEqual([
      { emoji: '🔥', count: 1, mine: true, names: [] },
      { emoji: '🎉', count: 1, mine: true, names: [] },
    ])

    const after = await react(ctx, 'member', ctx, { emoji: '🔥' }, 'DELETE')
    expect(await after.json()).toEqual([{ emoji: '🎉', count: 1, mine: true, names: [] }])
  })

  test('two users on the SAME emoji aggregate to count 2, and `mine` is per caller', async () => {
    const ctx = await setup()
    await react(ctx, 'owner', ctx, { emoji: '👍' })
    const second = await react(ctx, 'member', ctx, { emoji: '👍' })
    expect(await second.json()).toEqual([{ emoji: '👍', count: 2, mine: true, names: ['owner@example.com'] }])

    // The owner's view of the same row set: still 2, still mine.
    const ownersView = await react(ctx, 'owner', ctx, { emoji: '👍' })
    expect(await ownersView.json()).toEqual([{ emoji: '👍', count: 2, mine: true, names: ['member@example.com'] }])

    // A third user who has not reacted sees the count without `mine`.
    await mintUser(ctx.db, ctx.kv, 'watcher')
    await seedMember(ctx.db, ctx.spaceId, 'watcher')
    const [thread] = await list(ctx, 'watcher')
    expect(thread.comments[0].reactions).toEqual([
      { emoji: '👍', count: 2, mine: false, names: ['owner@example.com', 'member@example.com'] },
    ])
  })

  test('a MULTI-code-unit emoji round-trips whole (family = 11 UTF-16 units, not one char)', async () => {
    const ctx = await setup()
    const family = '👨‍👩‍👧‍👦'
    expect(family.length).toBe(11) // the reason the cap is measured generously, not at 1 or 2
    const res = await react(ctx, 'member', ctx, { emoji: family })
    expect(await res.json()).toEqual([{ emoji: family, count: 1, mine: true, names: [] }])
    expect((await ctx.db.select().from(commentReactions))[0].emoji).toBe(family)
  })
})

describe('comment reactions — validation', () => {
  test('a non-string, empty or whitespace-only emoji → 400 and nothing written', async () => {
    const ctx = await setup()
    for (const emoji of [42, null, {}, [], true, '', '   ']) {
      const res = await react(ctx, 'member', ctx, { emoji })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid emoji' })
    }
    // A missing key and a malformed body are the same 400.
    expect((await react(ctx, 'member', ctx, {})).status).toBe(400)
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(0)
  })

  test('past the 32-UTF-16-unit cap → 400; a 32-unit value is accepted', async () => {
    const ctx = await setup()
    const long = '🔥'.repeat(17) // 34 units
    expect((await react(ctx, 'member', ctx, { emoji: long })).status).toBe(400)

    const atCap = '🔥'.repeat(16) // exactly 32
    expect(atCap.length).toBe(32)
    expect((await react(ctx, 'member', ctx, { emoji: atCap })).status).toBe(200)
  })

  test('control chars are stripped, so a payload that is ONLY control chars is 400', async () => {
    const ctx = await setup()
    // Built, not written as a source literal (the same house rule stripControlChars follows):
    // BEL + ESC + DEL, the bytes that would inject terminal escapes into the Go CLI's output.
    const res = await react(ctx, 'member', ctx, { emoji: String.fromCharCode(7, 27, 127) })
    expect(res.status).toBe(400)
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(0)
  })

  test('a user is capped at 20 DISTINCT emojis on one comment; toggling an existing one still works', async () => {
    const ctx = await setup()
    const emojis = Array.from({ length: 21 }, (_, i) => String.fromCodePoint(0x1f600 + i))
    for (const emoji of emojis.slice(0, 20)) {
      expect((await react(ctx, 'member', ctx, { emoji })).status).toBe(200)
    }
    const over = await react(ctx, 'member', ctx, { emoji: emojis[20] })
    expect(over.status).toBe(400)
    expect(await over.json()).toEqual({ error: 'too many reactions' })
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(20)

    // The cap bounds ONE user's distinct set, not the comment's: another user still reacts…
    expect((await react(ctx, 'owner', ctx, { emoji: emojis[20] })).status).toBe(200)
    // …and re-adding one the capped user already holds is a converged no-op, not a 400.
    expect((await react(ctx, 'member', ctx, { emoji: emojis[0] })).status).toBe(200)
  })
})

describe('comment reactions — the access gate is the message routes’ own', () => {
  test('an outsider on a private page gets the site’s 403, and writes nothing', async () => {
    const ctx = await setup('private')
    await mintUser(ctx.db, ctx.kv, 'outsider')
    const res = await react(ctx, 'outsider', ctx, { emoji: '🔥' })
    expect(res.status).toBe(403)
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(0)
  })

  test('unknown site / wrong thread / unknown comment are all the same opaque 404', async () => {
    const ctx = await setup()
    const other = await seedThread(ctx.db, { siteId: ctx.siteId, filePath: 'index.html', createdBy: ctx.owner })

    const wrongSite = await ctx.app.request(
      `/api/sites/acme/nope/comments/${ctx.threadId}/messages/${ctx.commentId}/reactions`,
      { method: 'PUT', headers: auth('member'), body: JSON.stringify({ emoji: '🔥' }) },
      ctx.env,
    )
    expect(wrongSite.status).toBe(404)

    // The comment exists but hangs off a DIFFERENT thread than the URL claims.
    const mismatched = await react(ctx, 'member', { threadId: other, commentId: ctx.commentId }, { emoji: '🔥' })
    expect(mismatched.status).toBe(404)
    const ghost = await react(ctx, 'member', { threadId: ctx.threadId, commentId: 'ghost' }, { emoji: '🔥' })
    expect(ghost.status).toBe(404)
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(0)
  })

  test('a SOFT-DELETED comment takes no reaction — same 404 edit and delete already give it', async () => {
    const ctx = await setup()
    // A reply is what leaves a tombstone behind at all (#116): delete the opening of a thread with
    // nothing else in it and the thread goes, taking the very row this test is about.
    await seedComment(ctx.db, { threadId: ctx.threadId, authorId: ctx.owner, body: 'a reply' })
    await react(ctx, 'member', ctx, { emoji: '🔥' })
    const gone = await ctx.app.request(
      `/api/sites/acme/doc/comments/${ctx.threadId}/messages/${ctx.commentId}`,
      { method: 'DELETE', headers: auth('owner') },
      ctx.env,
    )
    expect(gone.status).toBe(200)

    expect((await react(ctx, 'member', ctx, { emoji: '🎉' })).status).toBe(404)
    expect((await react(ctx, 'member', ctx, { emoji: '🔥' }, 'DELETE')).status).toBe(404)
    // The rows already on the tombstone survive: a soft delete redacts the BODY, it does not
    // rewrite who reacted to it.
    expect(await ctx.db.select().from(commentReactions)).toHaveLength(1)
  })
})

// A chip that only counts leaves the reader guessing who is behind it, so each one carries the
// reactors' display names — the caller excluded (that is `mine`), in reaction order, and ALL of
// them: a reader hunting for one name gets nothing out of "and 4 others".
describe('comment reactions — who reacted', () => {
  test('names are the OTHER reactors, in reaction order, and never the caller', async () => {
    const ctx = await setup()
    for (const who of ['watcher', 'member']) {
      if (who === 'watcher') {
        await mintUser(ctx.db, ctx.kv, who)
        await seedMember(ctx.db, ctx.spaceId, who)
      }
      await react(ctx, who, ctx, { emoji: '👍' })
    }
    const mine = await react(ctx, 'owner', ctx, { emoji: '👍' })
    // Reaction order, not caller-first: the owner reacted last and is absent from its own list.
    expect(await mine.json()).toEqual([
      { emoji: '👍', count: 3, mine: true, names: ['watcher@example.com', 'member@example.com'] },
    ])
    // …and the same rows, read by someone who has not reacted, name all three.
    const [thread] = await list(ctx, 'watcher')
    expect(thread.comments[0].reactions).toEqual([
      { emoji: '👍', count: 3, mine: true, names: ['member@example.com', 'owner@example.com'] },
    ])
  })

  test('a crowd is named in full — the list is not summarised at some cap', async () => {
    const ctx = await setup()
    const crowd = Array.from({ length: 10 }, (_, i) => `fan${i}`)
    for (const who of crowd) {
      await mintUser(ctx.db, ctx.kv, who)
      await seedMember(ctx.db, ctx.spaceId, who)
      await react(ctx, who, ctx, { emoji: '🔥' })
    }
    const res = await react(ctx, 'member', ctx, { emoji: '🔥' })
    // Every reactor but the caller, so `count` is exactly `names.length` + 1.
    expect(await res.json()).toEqual([
      { emoji: '🔥', count: 11, mine: true, names: crowd.map((w) => `${w}@example.com`) },
    ])
  })

  test('a reactor with a name uses it, not the email the fallback would show', async () => {
    const ctx = await setup()
    await ctx.db.update(users).set({ name: 'Ada Lovelace' }).where(eq(users.id, ctx.owner))
    await react(ctx, 'owner', ctx, { emoji: '🎉' })
    const res = await react(ctx, 'member', ctx, { emoji: '🎉' })
    expect(await res.json()).toEqual([{ emoji: '🎉', count: 2, mine: true, names: ['Ada Lovelace'] }])
  })
})

describe('comment reactions — the GET fold', () => {
  test('reactions ride the list response, and a comment with none reads as []', async () => {
    const ctx = await setup()
    const bare = await seedComment(ctx.db, { threadId: ctx.threadId, authorId: ctx.owner, body: 'no reactions' })
    await react(ctx, 'member', ctx, { emoji: '🔥' })
    await react(ctx, 'owner', ctx, { emoji: '🔥' })
    await react(ctx, 'owner', ctx, { emoji: '🎉' })

    const [thread] = await list(ctx, 'member')
    expect(thread.comments.map((cm) => [cm.id, cm.reactions])).toEqual([
      [
        ctx.commentId,
        [
          { emoji: '🔥', count: 2, mine: true, names: ['owner@example.com'] },
          { emoji: '🎉', count: 1, mine: false, names: ['owner@example.com'] },
        ],
      ],
      [bare, []],
    ])
  })

  test('the fold costs NO extra round trip: still 1 loose read + ONE batch (now of 8)', async () => {
    const ctx = await setup()
    await react(ctx, 'member', ctx, { emoji: '🔥' })
    for (const extra of ['?filePath=index.html', '']) {
      ctx.db.resetCounters()
      await list(ctx, 'member', extra)
      expect(ctx.db.counters.loose).toBe(1) // requireAuth's user read — nothing else loose
      expect(ctx.db.counters.batches).toBe(1) // reactions FUSED into the list batch, not a 2nd trip
      expect(ctx.db.counters.batchStmts).toBe(8) // 5 access facts + threads + comments + reactions
    }
  })

  test('another site’s reactions never bleed into this site’s list', async () => {
    const ctx = await setup()
    const otherSpace = await seedSpace(ctx.db, { createdBy: ctx.owner, slug: 'other' })
    const otherSite = await seedSite(ctx.db, { spaceId: otherSpace, ownerId: ctx.owner, slug: 'doc' })
    const otherThread = await seedThread(ctx.db, { siteId: otherSite, filePath: 'index.html', createdBy: ctx.owner })
    const otherComment = await seedComment(ctx.db, { threadId: otherThread, authorId: ctx.owner, body: 'elsewhere' })
    await ctx.app.request(
      `/api/sites/other/doc/comments/${otherThread}/messages/${otherComment}/reactions`,
      { method: 'PUT', headers: auth('owner'), body: JSON.stringify({ emoji: '🔥' }) },
      ctx.env,
    )

    const [thread] = await list(ctx, 'member')
    expect(thread.comments[0].reactions).toEqual([])
  })
})
