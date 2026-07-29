import { describe, expect, test } from 'bun:test'
import type { Thread } from '@/lib/comments'
import { type AnchorRect, buildBadges, initialBadges, stepBadges } from './badges'

// Slice B2b — the overlay's pure badge model. stepBadges owns the async-batch race (an epoch that
// arrives late must not undo a newer one); buildBadges owns the presentation rules (visibility,
// placement, clustering, initials). Neither touches React or the DOM — see commentPopover.ts for
// the house style this mirrors.

const VP = { width: 800, height: 600 }

// Minimal Thread builder: only the fields buildBadges reads are meaningful, the rest are filler.
function mkThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    id: overrides.id,
    filePath: '/f',
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

const rect = (id: string, top: number, left: number, width = 40, height = 12): AnchorRect => ({
  id,
  rect: { top, left, width, height },
})

describe('stepBadges — epoch races', () => {
  test('a batch with a LOWER epoch is dropped, returning the SAME state by identity', () => {
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('a', 10, 10)] }, VP)
    const next = stepBadges(state, { epoch: -1, rects: [rect('b', 20, 20)] }, VP)
    expect(next).toBe(state) // identity, not just equal — lets a React memo bail out
  })

  test('a LOWER-but-positive epoch is dropped too — a late batch behind a real (not sentinel) epoch', () => {
    // Guarding only against epoch -1 (initialBadges' sentinel) would miss the actual production
    // failure mode: a batch from an earlier frame arriving after a later one, both real epochs.
    let state = stepBadges(initialBadges(), { epoch: 0, rects: [] }, VP)
    state = stepBadges(state, { epoch: 5, rects: [rect('a', 1, 1)] }, VP)
    const next = stepBadges(state, { epoch: 3, rects: [rect('b', 2, 2)] }, VP)
    expect(next).toBe(state)
  })

  test('an EQUAL epoch replaces the rects (a scroll frame moving them)', () => {
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('a', 10, 10)] }, VP)
    const next = stepBadges(state, { epoch: 0, rects: [rect('a', 99, 99)] }, VP)
    expect(next.rects).toEqual([rect('a', 99, 99)])
  })

  test('from initialBadges(), an epoch-0 batch applies', () => {
    const next = stepBadges(initialBadges(), { epoch: 0, rects: [rect('a', 1, 1)] }, VP)
    expect(next.epoch).toBe(0)
    expect(next.rects).toEqual([rect('a', 1, 1)])
  })

  test('SNAPSHOT not merge: an id absent from the new batch is gone from state.rects', () => {
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('a', 1, 1), rect('b', 2, 2)] }, VP)
    const next = stepBadges(state, { epoch: 1, rects: [rect('a', 1, 1)] }, VP)
    expect(next.rects).toEqual([rect('a', 1, 1)])
  })
})

describe('buildBadges — element threads badge exactly like text ones (C2b)', () => {
  test('an element thread with a resolved rect gets a badge the same way a text thread does', () => {
    const anchor = { selector: '#chart', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' }
    const threads = [mkThread({ id: 't1', anchorType: 'element', quote: null, anchor })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(1)
  })

  test('a resolved element thread and a resolved text thread on the same line merge into ONE badge', () => {
    const anchor = { selector: '#chart', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' }
    const threads = [
      mkThread({ id: 't1', anchorType: 'text' }),
      mkThread({ id: 't2', anchorType: 'element', quote: null, anchor }),
    ]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 11, 12)] }, VP)
    const badges = buildBadges(state, threads)
    expect(badges).toHaveLength(1)
    expect(badges[0]?.threadIds.sort()).toEqual(['t1', 't2'])
  })
})

describe('buildBadges — visibility', () => {
  test('a rect whose id matches no thread produces no badge', () => {
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('ghost', 10, 10)] }, VP)
    expect(buildBadges(state, [])).toEqual([])
  })

  test('a rect whose thread is resolved produces no badge', () => {
    const threads = [mkThread({ id: 't1', status: 'resolved' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect entirely above the viewport (top + height <= 0) produces no badge', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', -20, 10, 40, 20)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect straddling the top edge (top negative, top+height > 0) KEEPS a badge', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', -5, 10, 40, 20)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(1)
  })

  test('a rect below the viewport bottom produces no badge', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 700, 10)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect exactly AT the bottom boundary (top === viewport.height) produces no badge', () => {
    // Pins the bottom edge the same way the top edge's `<= 0` is pinned above — without this,
    // `>=` vs `>` at the boundary is unproven (a badge one pixel below the fold would leak in).
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 600, 10)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect entirely left of the viewport (left + width <= 0) produces no badge', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, -50, 40, 20)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect exactly AT the left boundary (left + width === 0) produces no badge', () => {
    // Pins the left edge the same way the top edge's `<= 0` is pinned above — the left edge was
    // only exercised at -10 (well past 0), leaving the exact boundary unproven.
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, -40, 40, 20)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect entirely right of the viewport (left >= viewport.width) produces no badge', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 800, 40, 20)] }, VP)
    expect(buildBadges(state, threads)).toEqual([])
  })

  test('a rect straddling the left edge KEEPS a badge', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, -20, 40, 20)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(1)
  })

  test('viewport {0,0} (not yet measured) produces no badges at all', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, { width: 0, height: 0 })
    expect(buildBadges(state, threads)).toEqual([])
  })
})

describe('buildBadges — placement', () => {
  test('top = rect.top, left = rect.left + rect.width', () => {
    const threads = [mkThread({ id: 't1' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 15, 20, 40, 12)] }, VP)
    const [badge] = buildBadges(state, threads)
    expect(badge?.top).toBe(15)
    expect(badge?.left).toBe(60)
  })
})

describe('buildBadges — cluster merge', () => {
  test('two rects 6px apart vertically and 10px apart horizontally merge into ONE badge', () => {
    const threads = [
      mkThread({ id: 't1', comments: [{ id: 'c1' } as never] }),
      mkThread({ id: 't2', comments: [{ id: 'c2' } as never, { id: 'c3' } as never] }),
    ]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 16, 20)] }, VP)
    const badges = buildBadges(state, threads)
    expect(badges).toHaveLength(1)
    expect(badges[0]?.threadIds.sort()).toEqual(['t1', 't2'])
    expect(badges[0]?.count).toBe(3) // sum of both threads' comments
  })

  test('two rects 40px apart vertically stay TWO badges', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 50, 10)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(2)
  })

  test('two same-line rects 30px apart horizontally (over the 24px tolerance) stay TWO badges', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 10, 40)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(2)
  })

  test('the merge sorts by (top, left) first, so the merged badge takes the topmost rect\'s position regardless of input order', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    // t2 (top 10) is fed AFTER t1 (top 20) — only a real sort puts t2 first so the cluster
    // inherits t2's position; input-order (or a left-first sort) would inherit t1's instead.
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 20, 10), rect('t2', 10, 12)] }, VP)
    const [badge] = buildBadges(state, threads)
    expect(badge?.top).toBe(10)
    expect(badge?.left).toBe(52)
  })

  test('two rects exactly 12px apart vertically (same left) merge into ONE badge — the declared boundary', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 22, 10)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(1)
  })

  test('two rects exactly 13px apart vertically (same left) stay TWO badges — one past the boundary', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 23, 10)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(2)
  })

  test('two same-line rects exactly 24px apart horizontally merge into ONE badge — the declared boundary', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 10, 34)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(1)
  })

  test('two same-line rects exactly 25px apart horizontally stay TWO badges — one past the boundary', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 10, 35)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(2)
  })

  test('a later-line anchor far to the LEFT of the cluster head stays a SEPARATE badge (kills a dropped horizontal Math.abs)', () => {
    // Sort is top-first, so t2 (top 20) is compared against head t1 (top 10, left 100) as
    // `t2.left - head.left` = 10 - 100 = -90. Without Math.abs that raw delta passes `<= 24`
    // and wrongly merges two badges on different lines/columns into one chip.
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 100), rect('t2', 20, 10)] }, VP)
    expect(buildBadges(state, threads)).toHaveLength(2)
  })

  // No equivalent test for a dropped VERTICAL Math.abs: the sort is top-first, so a later member's
  // top is provably >= the cluster head's top and the delta can never go negative — dropping that
  // Math.abs is a true equivalent mutant, not a gap.

  test('cluster tolerance is measured from the FIRST member, not a sliding chain off the last-added one', () => {
    // Three same-column rects 10px apart: t2 is within 12px of t1 so it joins t1's cluster, but
    // t3 is 20px from t1 (the cluster's first member) though only 10px from t2 (the last-added
    // one). Comparing against the first member keeps t3 out; comparing against the last member
    // would wrongly chain it in, drifting the cluster's effective span past the 12px tolerance.
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' }), mkThread({ id: 't3' })]
    const rects = [rect('t1', 10, 10), rect('t2', 20, 10), rect('t3', 30, 10)]
    const state = stepBadges(initialBadges(), { epoch: 0, rects }, VP)
    const badges = buildBadges(state, threads)
    expect(badges).toHaveLength(2)
    expect(badges.map((b) => b.threadIds)).toEqual([['t1', 't2'], ['t3']])
  })
})

describe('buildBadges — count', () => {
  const mkComment = (id: string, deleted: boolean): Thread['comments'][number] =>
    ({ id, authorId: 'u1', author: 'A', body: deleted ? null : 'hi', deleted, createdAt: '', editedAt: null }) as never

  test('a thread with 3 comments of which 1 is deleted contributes 2 to its badge count', () => {
    const threads = [
      mkThread({ id: 't1', comments: [mkComment('c1', false), mkComment('c2', true), mkComment('c3', false)] }),
    ]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)[0]?.count).toBe(2)
  })

  test('a thread whose comments are ALL deleted contributes 0 to the cluster count', () => {
    const threads = [mkThread({ id: 't1', comments: [mkComment('c1', true), mkComment('c2', true)] })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)[0]?.count).toBe(0)
  })
})

describe('buildBadges — initials', () => {
  test("'Sam Lawerence' -> 'SL'", () => {
    const threads = [mkThread({ id: 't1', createdByName: 'Sam Lawerence' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)[0]?.initials).toEqual(['SL'])
  })

  test("single-word 'ada' -> 'A'", () => {
    const threads = [mkThread({ id: 't1', createdByName: 'ada' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)[0]?.initials).toEqual(['A'])
  })

  test("null createdByName falls back to first non-deleted comment author 'Rk Roy' -> 'RR'", () => {
    const threads = [
      mkThread({
        id: 't1',
        createdByName: null,
        comments: [
          { id: 'c1', authorId: null, author: null, body: null, deleted: true, createdAt: '', editedAt: null },
          {
            id: 'c2',
            authorId: 'u1',
            author: 'Rk Roy',
            body: 'hi',
            deleted: false,
            createdAt: '',
            editedAt: null,
          },
        ],
      }),
    ]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)[0]?.initials).toEqual(['RR'])
  })

  test('no name anywhere -> ?', () => {
    const threads = [mkThread({ id: 't1', createdByName: null, comments: [] })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10)] }, VP)
    expect(buildBadges(state, threads)[0]?.initials).toEqual(['?'])
  })

  test('a cluster of 5 distinct authors keeps the FIRST 3 in encounter order, extra = 2', () => {
    const names = ['Amy Adams', 'Bob Brown', 'Cara Clark', 'Dana Diaz', 'Ed Evans']
    const threads = names.map((name, i) => mkThread({ id: `t${i}`, createdByName: name }))
    const rects = threads.map((t, i) => rect(t.id, 10 + i, 10)) // all within cluster tolerance, in order
    const state = stepBadges(initialBadges(), { epoch: 0, rects }, VP)
    const [badge] = buildBadges(state, threads)
    // Distinct per-author initials (AA/BB/CC/DD/EE) so slicing the LAST 3 or a reversed first-3
    // would produce a different array, not just a different length.
    expect(badge?.initials).toEqual(['AA', 'BB', 'CC'])
    expect(badge?.extra).toBe(2)
  })

  test('two threads by the SAME author in one cluster collapse to one initial, extra 0', () => {
    const threads = [
      mkThread({ id: 't1', createdByName: 'Sam Lawerence' }),
      mkThread({ id: 't2', createdByName: 'Sam Lawerence' }),
    ]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 11, 12)] }, VP)
    const [badge] = buildBadges(state, threads)
    expect(badge?.initials).toEqual(['SL'])
    expect(badge?.extra).toBe(0)
  })
})

describe('buildBadges — key', () => {
  test('key is the member ids joined by "," and is stable across calls with the same members', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    const state = stepBadges(initialBadges(), { epoch: 0, rects: [rect('t1', 10, 10), rect('t2', 11, 12)] }, VP)
    const first = buildBadges(state, threads)[0]?.key
    const second = buildBadges(state, threads)[0]?.key
    expect(first).toBe('t1,t2')
    expect(second).toBe(first)
  })
})
