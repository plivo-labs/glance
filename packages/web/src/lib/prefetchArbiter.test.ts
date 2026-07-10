import { describe, expect, test } from 'bun:test'
import { type ArbiterEvent, type ArbiterState, initialArbiter, type StepResult, stepArbiter } from './prefetchArbiter'

// T11.2–T11.4 — the viewer's comments-load ordering rules, all pinned at the reducer. NOTE: a
// reducer suite cannot prove real-iframe timing (a genuinely late postMessage racing React
// effects) — the G4 real-browser smoke is the net for that; these tests pin the decisions the
// component executes.

type Data = string[]
const THREADS: Data = ['t1', 't2']
const NEWER: Data = ['t3']

// Drive a sequence of events, returning the final state + every decision in order.
function run(expected: string | null, events: ArbiterEvent<Data>[]): { state: ArbiterState<Data>; decisions: StepResult<Data>['decision'][] } {
  let state = initialArbiter<Data>(expected)
  const decisions: StepResult<Data>['decision'][] = []
  for (const e of events) {
    const step = stepArbiter(state, e)
    state = step.state
    decisions.push(step.decision)
  }
  return { state, decisions }
}

describe('generation arbitration (T11.2)', () => {
  test('older same-path prefetch settling after a newer refresh is ignored; the refresh applies', () => {
    const { decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: true }, // gen 1 (prefetch)
      { type: 'start', path: 'index.html', provisional: false }, // gen 2 (refresh) supersedes
      { type: 'settled', gen: 1, ok: true, data: THREADS }, // stale success — SAME path
      { type: 'settled', gen: 2, ok: true, data: NEWER },
    ])
    expect(decisions[2]).toEqual({ kind: 'ignore' })
    expect(decisions[3]).toEqual({ kind: 'apply', path: 'index.html', data: NEWER })
  })

  test('a stale REJECTION after a newer success is ignored — never an error decision', () => {
    const { state, decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: false }, // gen 1
      { type: 'start', path: 'index.html', provisional: false }, // gen 2
      { type: 'settled', gen: 2, ok: true, data: NEWER },
      { type: 'settled', gen: 1, ok: false, error: new Error('boom') }, // stale rejection
    ])
    expect(decisions[2]).toEqual({ kind: 'apply', path: 'index.html', data: NEWER })
    expect(decisions[3]).toEqual({ kind: 'ignore' })
    expect(state.inFlight).toBeNull()
  })

  test('a CURRENT-generation ad-hoc failure does surface as error', () => {
    const err = new Error('boom')
    const { decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: false },
      { type: 'settled', gen: 1, ok: false, error: err },
    ])
    expect(decisions[1]).toEqual({ kind: 'error', error: err })
  })
})

describe('provisional prefetch rules (T11.3)', () => {
  test('HTML prefetch is parked on settle and applies only on the MATCHING ready', () => {
    const { decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: true },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
      { type: 'ready', path: 'index.html' },
    ])
    expect(decisions[1]).toEqual({ kind: 'none' }) // parked, NOT applied
    expect(decisions[2]).toEqual({ kind: 'apply', path: 'index.html', data: THREADS })
  })

  test('ready arriving BEFORE the prefetch settles: no refetch, result applies on settle', () => {
    const { decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: true },
      { type: 'ready', path: 'index.html' }, // in flight for this exact path → wait for it
      { type: 'settled', gen: 1, ok: true, data: THREADS },
    ])
    expect(decisions[1]).toEqual({ kind: 'none' })
    expect(decisions[2]).toEqual({ kind: 'apply', path: 'index.html', data: THREADS })
  })

  test('MISMATCHED ready discards the parked prefetch and orders a fresh fetch', () => {
    const { state, decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: true },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
      { type: 'ready', path: 'other.html' }, // the iframe's REAL path wins over our guess
    ])
    expect(decisions[2]).toEqual({ kind: 'refetch', path: 'other.html' })
    expect(state.pending).toBeNull() // discarded, never applied
    expect(state.readyPath).toBe('other.html')
  })

  test('NO ready ever (directory listing emits none): the prefetch is never applied', () => {
    const { state, decisions } = run('docs/index.html', [
      { type: 'start', path: 'docs/index.html', provisional: true },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
    ])
    expect(decisions.every((d) => d.kind !== 'apply')).toBe(true)
    expect(state.pending).toEqual({ path: 'docs/index.html', data: THREADS }) // parked forever
  })

  test('AUDIO (non-provisional) applies immediately on settle — no ready exists for it', () => {
    const { decisions } = run('recording.webm', [
      { type: 'start', path: 'recording.webm', provisional: false },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
    ])
    expect(decisions[1]).toEqual({ kind: 'apply', path: 'recording.webm', data: THREADS })
  })

  test('duplicate ready for the same path → ignored, no refetch', () => {
    const { decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: true },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
      { type: 'ready', path: 'index.html' },
      { type: 'ready', path: 'index.html' },
    ])
    expect(decisions[3]).toEqual({ kind: 'ignore' })
  })

  test('provisional prefetch FAILURE is benign (discard); the later ready refetches', () => {
    const { decisions } = run('index.html', [
      { type: 'start', path: 'index.html', provisional: true },
      { type: 'settled', gen: 1, ok: false, error: null },
      { type: 'ready', path: 'index.html' },
    ])
    expect(decisions[1]).toEqual({ kind: 'discard' }) // never an error/toast
    expect(decisions[2]).toEqual({ kind: 'refetch', path: 'index.html' })
  })

  test('confirmed in-iframe navigation to another file → refetch for the new path', () => {
    const { state, decisions } = run('index.html', [
      { type: 'ready', path: 'index.html' },
      { type: 'ready', path: 'page2.html' },
    ])
    expect(decisions[1]).toEqual({ kind: 'refetch', path: 'page2.html' })
    expect(state.readyPath).toBe('page2.html')
  })

  test('no prefetch (expected null): first ready is still trusted and refetched', () => {
    const { state, decisions } = run(null, [{ type: 'ready', path: 'lone.html' }])
    expect(decisions[0]).toEqual({ kind: 'refetch', path: 'lone.html' })
    expect(state.confirmed).toBe(true)
  })
})

describe('splat-navigation reset (T11.4)', () => {
  test('navReset clears per-file state but keeps the generation clock monotonic', () => {
    let state = initialArbiter<Data>('a.html')
    for (const e of [
      { type: 'start', path: 'a.html', provisional: true },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
      { type: 'ready', path: 'a.html' },
    ] as ArbiterEvent<Data>[]) {
      state = stepArbiter(state, e).state
    }
    const reset = stepArbiter(state, { type: 'navReset', expected: 'b.html' }).state
    expect(reset).toEqual({
      gen: 1, // NOT rewound — a pre-nav settle must stay stale
      expected: 'b.html',
      staleHint: 'a.html',
      confirmed: false,
      readyPath: null,
      inFlight: null,
      pending: null,
    })
    // generations keep counting up after the reset
    expect(stepArbiter(reset, { type: 'start', path: 'b.html', provisional: true }).state.gen).toBe(2)
  })

  test('a stale ready from the OLD iframe src after nav is ignored; the new file still confirms', () => {
    const { state, decisions } = run('a.html', [
      { type: 'ready', path: 'a.html' },
      { type: 'navReset', expected: 'b.html' },
      { type: 'start', path: 'b.html', provisional: true }, // new prefetch (gen 1)
      { type: 'settled', gen: 1, ok: true, data: NEWER },
      { type: 'ready', path: 'a.html' }, // late message from the old document
      { type: 'ready', path: 'b.html' },
    ])
    expect(decisions[4]).toEqual({ kind: 'ignore' }) // stale — no discard, no refetch
    expect(decisions[5]).toEqual({ kind: 'apply', path: 'b.html', data: NEWER })
    expect(state.readyPath).toBe('b.html')
  })

  test('an in-flight pre-nav load settling after navReset is ignored', () => {
    const { decisions } = run('a.html', [
      { type: 'start', path: 'a.html', provisional: true }, // gen 1
      { type: 'navReset', expected: 'b.html' },
      { type: 'settled', gen: 1, ok: true, data: THREADS },
    ])
    expect(decisions[2]).toEqual({ kind: 'ignore' })
  })

  test('after nav, even a never-confirmed old EXPECTED path is a stale hint', () => {
    // the old iframe never got to emit ready before the user navigated on
    const { decisions } = run('a.html', [
      { type: 'navReset', expected: 'b.html' },
      { type: 'ready', path: 'a.html' }, // old doc's ready arriving after the nav
    ])
    expect(decisions[1]).toEqual({ kind: 'ignore' })
  })
})
