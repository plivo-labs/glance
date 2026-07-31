import { describe, expect, test } from 'bun:test'
import { makeDb, seedComment, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { buildCommentCreatedView, buildThreadCreatedView, commentByIdStmt, threadByIdStmt } from './comments'

// S4 — viewer-independent push payload builders. Both builders reuse the SAME assembly the list
// route runs (assembleThreadViews / toCommentView) rather than a hand-rolled second shape, so a
// pushed thread/comment and a reloaded one can never silently drift apart (C5 pins the strongest
// form of that — byte-identical to the real GET route — in routes/comment-push-payload.test.ts).

/** A bare site + one author user; threads/comments are wired per test. */
async function bareSite() {
  const db = makeDb()
  const owner = await seedUser(db, { id: 'owner' })
  const sp = await seedSpace(db, { createdBy: owner })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: owner })
  return { db, siteId }
}

/** Every object key at any depth — the honest form of "this key never appears anywhere". */
function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      keysDeep(v, out)
    }
  }
  return out
}

describe('buildThreadCreatedView — a just-created thread, via the SAME assembler the list route uses', () => {
  test('returns the exact ThreadView shape, reactions: []', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'author1', name: 'Author One', email: 'author1@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', createdBy: author })
    const commentId = await seedComment(db, { threadId, authorId: author, body: 'opening comment' })
    const thread = (await threadByIdStmt(db, threadId))[0]!
    const comment = (await commentByIdStmt(db, commentId))[0]!

    const view = buildThreadCreatedView(
      { thread, creatorName: 'Author One', creatorEmail: 'author1@example.com', resolverName: null, resolverEmail: null },
      { comment, authorName: 'Author One', authorEmail: 'author1@example.com' },
    )

    expect(view).toEqual({
      id: threadId,
      filePath: 'index.html',
      anchorType: 'page',
      quote: null,
      anchor: null,
      context: null,
      status: 'open',
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
      createdBy: author,
      createdByName: 'Author One',
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      comments: [
        {
          id: commentId,
          authorId: author,
          author: 'Author One',
          body: 'opening comment',
          deleted: false,
          hasAudio: false,
          reactions: [],
          createdAt: comment.createdAt,
          editedAt: null,
        },
      ],
    })
  })

  test('author display name fallback: null name -> email, same as the list join', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'noname1', name: null, email: 'noname1@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', createdBy: author })
    const commentId = await seedComment(db, { threadId, authorId: author, body: 'hi' })
    const thread = (await threadByIdStmt(db, threadId))[0]!
    const comment = (await commentByIdStmt(db, commentId))[0]!

    const view = buildThreadCreatedView(
      { thread, creatorName: null, creatorEmail: 'noname1@example.com', resolverName: null, resolverEmail: null },
      { comment, authorName: null, authorEmail: 'noname1@example.com' },
    )

    expect(view.createdByName).toBe('noname1@example.com')
    expect(view.comments[0].author).toBe('noname1@example.com')
  })
})

describe('buildCommentCreatedView — a reply, via the SAME per-row mapping the list route uses (C6)', () => {
  test('C6: { threadId, comment } with reactions: []', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'author2', name: 'Author Two', email: 'author2@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    const commentId = await seedComment(db, { threadId, authorId: author, body: 'a reply' })
    const comment = (await commentByIdStmt(db, commentId))[0]!

    const payload = buildCommentCreatedView(threadId, { comment, authorName: 'Author Two', authorEmail: 'author2@example.com' })

    expect(payload).toEqual({
      threadId,
      comment: {
        id: commentId,
        authorId: author,
        author: 'Author Two',
        body: 'a reply',
        deleted: false,
        hasAudio: false,
        reactions: [],
        createdAt: comment.createdAt,
        editedAt: null,
      },
    })
  })

  test('author display name fallback: null name -> email, same as the list join', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'noname2', name: null, email: 'noname2@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    const commentId = await seedComment(db, { threadId, authorId: author, body: 'hi' })
    const comment = (await commentByIdStmt(db, commentId))[0]!

    const payload = buildCommentCreatedView(threadId, { comment, authorName: null, authorEmail: 'noname2@example.com' })
    expect(payload.comment.author).toBe('noname2@example.com')
  })
})

describe('C7 — no built payload carries a reactor id or a true `mine`, provable on the wire', () => {
  test('thread.created payload: deep scan finds no `mine` key and no `userId` key anywhere', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'author3', name: 'Author Three', email: 'author3@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', createdBy: author })
    const commentId = await seedComment(db, { threadId, authorId: author, body: 'hi' })
    const thread = (await threadByIdStmt(db, threadId))[0]!
    const comment = (await commentByIdStmt(db, commentId))[0]!

    const view = buildThreadCreatedView(
      { thread, creatorName: 'Author Three', creatorEmail: 'author3@example.com', resolverName: null, resolverEmail: null },
      { comment, authorName: 'Author Three', authorEmail: 'author3@example.com' },
    )
    const keys = keysDeep(view)
    expect(keys).not.toContain('mine')
    expect(keys).not.toContain('userId')
    expect(JSON.stringify(view)).not.toContain('"mine"')
  })

  test('comment.created payload: deep scan finds no `mine` key and no `userId` key anywhere', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'author4', name: 'Author Four', email: 'author4@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    const commentId = await seedComment(db, { threadId, authorId: author, body: 'a reply' })
    const comment = (await commentByIdStmt(db, commentId))[0]!

    const payload = buildCommentCreatedView(threadId, { comment, authorName: 'Author Four', authorEmail: 'author4@example.com' })
    const keys = keysDeep(payload)
    expect(keys).not.toContain('mine')
    expect(keys).not.toContain('userId')
    expect(JSON.stringify(payload)).not.toContain('"mine"')
  })
})
