import { describe, expect, test } from 'bun:test'
import { type CommentEvent, applyCommentEvent } from './applyCommentEvent'
import type { CommentItem, Thread } from './comments'

// S7: the client half of the realtime comment path, kept PURE so idempotence (ruled decision 4 —
// what replaced seq/cursor once the client stopped being able to see one) is provable on plain
// objects, no browser/React involved.

function mkThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    id: overrides.id,
    filePath: 'index.html',
    anchorType: 'text',
    quote: 'q',
    anchor: null,
    context: null,
    status: 'open',
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: null,
    createdByName: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comments: [],
    ...overrides,
  }
}

function mkComment(overrides: Partial<CommentItem> & { id: string }): CommentItem {
  return {
    id: overrides.id,
    authorId: 'user_sam',
    author: 'Sam Lawerence',
    body: 'hi',
    deleted: false,
    reactions: [],
    createdAt: '2024-01-01',
    editedAt: null,
    ...overrides,
  }
}

const FILE = 'index.html'
const SITE = 'site_1'

describe('applyCommentEvent', () => {
  // C11 (P0): applying the same thread.created twice yields the SAME array reference the second
  // time (requirement 6 — a no-op event must not repaint the iframe), not just a deep-equal one.
  // The redelivery is a JSON round-trip of the first event, exactly like a socket frame that gets
  // JSON.parse'd fresh on the wire: over-the-wire redelivery never hands back the same in-memory
  // object, so dedup keyed on object identity (rather than the thread's id) would wrongly miss it.
  test('C11 — thread.created applied twice is a no-op the second time', () => {
    const newThread = mkThread({ id: 't1' })
    const event: CommentEvent = { type: 'thread.created', siteId: SITE, filePath: FILE, thread: newThread }
    const once = applyCommentEvent([], event, FILE)
    const redelivered: CommentEvent = JSON.parse(JSON.stringify(event))
    const twice = applyCommentEvent(once, redelivered, FILE)
    expect(twice).toBe(once)
  })

  test('C11 — comment.created applied twice is a no-op the second time', () => {
    const threads = [mkThread({ id: 't1' })]
    const comment = mkComment({ id: 'c1' })
    const event: CommentEvent = { type: 'comment.created', siteId: SITE, filePath: FILE, threadId: 't1', comment }
    const once = applyCommentEvent(threads, event, FILE)
    const redelivered: CommentEvent = JSON.parse(JSON.stringify(event))
    const twice = applyCommentEvent(once, redelivered, FILE)
    expect(twice).toBe(once)
  })

  // Dedup keys on id, not content: a redelivery can legitimately carry different field values (e.g.
  // reactions changed between the original push and a retry) and must still be recognized as the
  // same comment — content-equality dedup would wrongly append it as a second copy.
  test('C11 — a redelivered comment.created with different content is still deduped by id', () => {
    const threads = [mkThread({ id: 't1', comments: [mkComment({ id: 'c1', body: 'original' })] })]
    const event: CommentEvent = {
      type: 'comment.created',
      siteId: SITE,
      filePath: FILE,
      threadId: 't1',
      comment: mkComment({ id: 'c1', body: 'edited', reactions: [{ emoji: '👍', count: 1, mine: true, names: [] }] }),
    }
    const result = applyCommentEvent(threads, event, FILE)
    expect(result).toBe(threads)
  })

  // C12 (P0): an event for another filePath, or a comment.created for an unknown thread, changes
  // NOTHING — assert same reference, not just deep-equal (requirement 6: the viewer repaints the
  // iframe off `threads` identity).
  test('C12 — an event for another filePath returns the same array reference', () => {
    const threads = [mkThread({ id: 't1' })]
    const event: CommentEvent = {
      type: 'thread.created',
      siteId: SITE,
      filePath: 'other.html',
      thread: mkThread({ id: 't2', filePath: 'other.html' }),
    }
    expect(applyCommentEvent(threads, event, FILE)).toBe(threads)
  })

  test('C12 — comment.created for an unknown threadId returns the same array reference', () => {
    const threads = [mkThread({ id: 't1' })]
    const event: CommentEvent = {
      type: 'comment.created',
      siteId: SITE,
      filePath: FILE,
      threadId: 'ghost',
      comment: mkComment({ id: 'c1' }),
    }
    expect(applyCommentEvent(threads, event, FILE)).toBe(threads)
  })

  // A thread.created for the current file is appended — GET .../comments orders threads by
  // (filePath, createdAt, rowid) ascending, so a just-pushed thread (newest createdAt) belongs at
  // the END, same spot a reload would put it.
  test('thread.created for the current filePath is appended at the end', () => {
    const existing = mkThread({ id: 't1' })
    const newThread = mkThread({ id: 't2', createdAt: '2024-06-01' })
    const event: CommentEvent = { type: 'thread.created', siteId: SITE, filePath: FILE, thread: newThread }
    const result = applyCommentEvent([existing], event, FILE)
    expect(result).toEqual([existing, newThread])
  })

  // comment.created for a known thread appends to THAT thread's comments and leaves every other
  // thread's reference untouched — a sibling thread must not re-render off this event.
  test('comment.created appends to its thread and leaves other threads untouched', () => {
    const t1 = mkThread({ id: 't1', comments: [mkComment({ id: 'c0' })] })
    const t2 = mkThread({ id: 't2' })
    const newComment = mkComment({ id: 'c1' })
    const event: CommentEvent = { type: 'comment.created', siteId: SITE, filePath: FILE, threadId: 't1', comment: newComment }
    const result = applyCommentEvent([t1, t2], event, FILE)
    expect(result[0].comments).toEqual([t1.comments[0], newComment])
    expect(result[1]).toBe(t2)
  })

  // comment.created for a thread that is NOT at index 0 must land in ITS OWN slot — a reducer that
  // wrote to threads[idx] using the wrong index (e.g. always threads[0]) would both corrupt the
  // first thread's comments AND silently lose the pushed comment from its real thread.
  test('comment.created for a thread that is not first writes into that thread, not index 0', () => {
    const t1 = mkThread({ id: 't1', comments: [mkComment({ id: 'c0' })] })
    const t2 = mkThread({ id: 't2', comments: [] })
    const newComment = mkComment({ id: 'c1' })
    const event: CommentEvent = { type: 'comment.created', siteId: SITE, filePath: FILE, threadId: 't2', comment: newComment }
    const result = applyCommentEvent([t1, t2], event, FILE)
    expect(result[1].id).toBe('t2')
    expect(result[1].comments).toEqual([newComment])
    expect(result[0]).toBe(t1)
    expect(result[0].comments).toEqual([mkComment({ id: 'c0' })])
  })

  // A duplicate thread.created must not touch the CALLER's array or its existing thread objects —
  // a dedup path implemented as `threads[dup] = event.thread; return threads` would return the same
  // reference (satisfying the C11 idempotence check) while mutating the input in place and swapping
  // the existing thread's content for the incoming one.
  test('a duplicate thread.created does not mutate the input array or its thread objects', () => {
    const t1 = mkThread({ id: 't1', quote: 'original quote' })
    const threads = [t1]
    const threadsSnapshot = [...threads]
    const t1Snapshot = { ...t1 }
    const event: CommentEvent = {
      type: 'thread.created',
      siteId: SITE,
      filePath: FILE,
      thread: mkThread({ id: 't1', quote: 'incoming quote' }),
    }
    applyCommentEvent(threads, event, FILE)
    expect(threads).toEqual(threadsSnapshot)
    expect(threads[0]).toBe(t1)
    expect(t1).toEqual(t1Snapshot)
  })

  // Purity on the thread.created path too — a setState(threads) with the array pushed into in place
  // hands React the same reference, which bails out of the re-render while silently corrupting the
  // previous state, worse than returning a wrong list.
  test('does not mutate the input array when adding a thread', () => {
    const threads = [mkThread({ id: 't1' })]
    const snapshot = [...threads]
    const event: CommentEvent = { type: 'thread.created', siteId: SITE, filePath: FILE, thread: mkThread({ id: 't2' }) }
    applyCommentEvent(threads, event, FILE)
    expect(threads).toEqual(snapshot)
  })

  // Purity: neither the input array nor the input thread objects are mutated.
  test('does not mutate the input array or thread objects', () => {
    const t1 = mkThread({ id: 't1', comments: [mkComment({ id: 'c0' })] })
    const threads = [t1]
    const threadsSnapshot = [...threads]
    const t1Snapshot = { ...t1, comments: [...t1.comments] }
    const event: CommentEvent = {
      type: 'comment.created',
      siteId: SITE,
      filePath: FILE,
      threadId: 't1',
      comment: mkComment({ id: 'c1' }),
    }
    applyCommentEvent(threads, event, FILE)
    expect(threads).toEqual(threadsSnapshot)
    expect(t1).toEqual(t1Snapshot)
  })
})
