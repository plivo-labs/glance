import { describe, expect, test } from 'bun:test'
import { buildThreadCreatedView, commentByIdStmt, createThread, threadByIdStmt } from '../db/comments'
import { seedSite, seedSpace, seedUser } from '../test/harness'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'

// S4 C5 (P0): a pushed thread.created payload must be BYTE-IDENTICAL to what GET
// /:space/:site/comments?filePath=… returns for the same thread — that equality is what stops
// live and reloaded silently drifting apart. buildThreadCreatedView is NOT wired into the create
// route (that is S5); this test builds the push payload standalone and diffs it against a REAL
// list-endpoint response for the same seeded thread.

describe('S4 C5 — thread.created payload equals the real GET list response', () => {
  test('byte-identical (toEqual) for the same seeded thread', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const author = await seedUser(db, { id: 'author1', name: 'Author One', email: 'author1@example.com' })
    const spaceId = await seedSpace(db, { createdBy: owner, slug: 'acme' })
    const siteId = await seedSite(db, { spaceId, ownerId: owner, slug: 'doc' })

    const out = await createThread(db, { siteId, filePath: 'index.html', createdBy: author, body: 'hello world' })

    const res = await app.request('/api/sites/acme/doc/comments?filePath=index.html', { headers: auth(owner) }, env)
    expect(res.status).toBe(200)
    const listed = (await res.json()) as Array<{ id: string }>
    const listedThread = listed.find((t) => t.id === out.threadId)
    expect(listedThread).toBeDefined()

    const thread = (await threadByIdStmt(db, out.threadId))[0]!
    const comment = (await commentByIdStmt(db, out.openingCommentId))[0]!
    const pushed = buildThreadCreatedView(
      { thread, creatorName: 'Author One', creatorEmail: 'author1@example.com', resolverName: null, resolverEmail: null },
      { comment, authorName: 'Author One', authorEmail: 'author1@example.com' },
    )

    expect(pushed).toEqual(listedThread)
  })

  test('byte-identical even with a null-name author (the fallback path both sides share)', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const author = await seedUser(db, { id: 'noname1', name: null, email: 'noname1@example.com' })
    const spaceId = await seedSpace(db, { createdBy: owner, slug: 'acme' })
    const siteId = await seedSite(db, { spaceId, ownerId: owner, slug: 'doc' })

    const out = await createThread(db, { siteId, filePath: 'index.html', createdBy: author, body: 'hello' })

    const res = await app.request('/api/sites/acme/doc/comments?filePath=index.html', { headers: auth(owner) }, env)
    const listed = (await res.json()) as Array<{ id: string }>
    const listedThread = listed.find((t) => t.id === out.threadId)

    const thread = (await threadByIdStmt(db, out.threadId))[0]!
    const comment = (await commentByIdStmt(db, out.openingCommentId))[0]!
    const pushed = buildThreadCreatedView(
      { thread, creatorName: null, creatorEmail: 'noname1@example.com', resolverName: null, resolverEmail: null },
      { comment, authorName: null, authorEmail: 'noname1@example.com' },
    )

    expect(pushed).toEqual(listedThread)
  })
})
