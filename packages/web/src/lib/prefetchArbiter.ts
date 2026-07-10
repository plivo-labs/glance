// The viewer's comments-load arbiter (S11) — a pure reducer, unit-tested; the component only
// executes its decisions. It exists because the comments prefetch now races the iframe:
//
// - GENERATIONS: every load (prefetch, ready-triggered fetch, mutation refresh) gets a monotonic
//   generation; only the LATEST one may settle into state. An older in-flight result — including a
//   same-path one — is ignored, and a stale REJECTION never clears/toasts over a newer success.
// - PROVISIONAL prefetch: an HTML prefetch is a guess about the file the iframe will land on. Its
//   result is held (never painted) until a matching glance:ready confirms the path; a mismatched
//   ready discards it and orders a fresh fetch; if no ready ever arrives (directory listings emit
//   none) it is simply never applied. Audio has no iframe/ready → non-provisional, applies on settle.
// - STALE READY: after a splat navigation the OLD iframe document can still deliver a late ready.
//   navReset records the old path as `staleHint`; a pre-confirmation ready matching it is ignored,
//   while any other pre-confirmation mismatch is the iframe's REAL path winning over our guess.

export interface InFlight {
  gen: number
  path: string
  /** true = HTML prefetch, held for a matching glance:ready; false = applies on settle. */
  provisional: boolean
}

export interface ArbiterState<T> {
  /** Highest generation issued; monotonic across navResets so pre-nav settles stay stale. */
  gen: number
  /** Predicted entry path (resolveEntryPath); null = no prefetch (no guess was possible). */
  expected: string | null
  /** The old document's path at navReset time — a late ready for it is stale, not a navigation. */
  staleHint: string | null
  /** True once a glance:ready confirmed the iframe's real path. */
  confirmed: boolean
  /** The confirmed iframe file path (what the viewer may treat as current). */
  readyPath: string | null
  inFlight: InFlight | null
  /** A settled provisional prefetch parked until its ready arrives. */
  pending: { path: string; data: T } | null
}

export type ArbiterEvent<T> =
  | { type: 'start'; path: string; provisional: boolean }
  | { type: 'settled'; gen: number; ok: true; data: T }
  | { type: 'settled'; gen: number; ok: false; error: unknown }
  | { type: 'ready'; path: string }
  | { type: 'navReset'; expected: string | null }

export type Decision<T> =
  | { kind: 'none' } // state advanced (start / parked provisional / reset) — nothing to do
  | { kind: 'ignore' } // stale: superseded generation, duplicate ready, or old-iframe ready
  | { kind: 'discard' } // provisional result dropped (mismatch / benign prefetch failure)
  | { kind: 'apply'; path: string; data: T } // paint these threads
  | { kind: 'refetch'; path: string } // the iframe's real path has no usable data — load it
  | { kind: 'error'; error: unknown } // CURRENT-generation ad-hoc failure — surface it

export interface StepResult<T> {
  state: ArbiterState<T>
  decision: Decision<T>
}

export function initialArbiter<T>(expected: string | null): ArbiterState<T> {
  return { gen: 0, expected, staleHint: null, confirmed: false, readyPath: null, inFlight: null, pending: null }
}

// A ready established `path` as the iframe's real file. Use the parked/in-flight data when it was
// fetched FOR this exact path; anything else (mismatch) is discarded and refetched.
function confirm<T>(state: ArbiterState<T>, path: string, matchesExpected: boolean): StepResult<T> {
  const confirmed: ArbiterState<T> = { ...state, confirmed: true, readyPath: path, pending: null }
  if (matchesExpected && state.pending && state.pending.path === path)
    return { state: confirmed, decision: { kind: 'apply', path, data: state.pending.data } }
  if (matchesExpected && state.inFlight && state.inFlight.path === path)
    return { state: confirmed, decision: { kind: 'none' } } // still in flight — applies on settle
  return { state: confirmed, decision: { kind: 'refetch', path } }
}

export function stepArbiter<T>(state: ArbiterState<T>, event: ArbiterEvent<T>): StepResult<T> {
  switch (event.type) {
    case 'start': {
      // A newer load supersedes EVERYTHING older: the in-flight generation and any parked result.
      const gen = state.gen + 1
      return {
        state: { ...state, gen, inFlight: { gen, path: event.path, provisional: event.provisional }, pending: null },
        decision: { kind: 'none' },
      }
    }

    case 'settled': {
      if (state.inFlight === null || state.inFlight.gen !== event.gen) return { state, decision: { kind: 'ignore' } }
      const { path, provisional } = state.inFlight
      const next: ArbiterState<T> = { ...state, inFlight: null }
      if (!event.ok) {
        // A provisional prefetch failing is benign (the ready-path will refetch); a current ad-hoc
        // failure surfaces. Stale rejections never reach here (generation check above).
        return { state: next, decision: provisional ? { kind: 'discard' } : { kind: 'error', error: event.error } }
      }
      if (!provisional) return { state: next, decision: { kind: 'apply', path, data: event.data } }
      if (state.confirmed) {
        return state.readyPath === path
          ? { state: next, decision: { kind: 'apply', path, data: event.data } }
          : { state: next, decision: { kind: 'discard' } }
      }
      // No ready yet: park it. If no ready ever arrives, it is never applied.
      return { state: { ...next, pending: { path, data: event.data } }, decision: { kind: 'none' } }
    }

    case 'ready': {
      const { path } = event
      if (!state.confirmed) {
        const matchesExpected = state.expected !== null && path === state.expected
        // A late ready from the OLD document (splat nav) — never a navigation, never a refetch.
        if (!matchesExpected && path === state.staleHint) return { state, decision: { kind: 'ignore' } }
        return confirm(state, path, matchesExpected)
      }
      if (path === state.readyPath) return { state, decision: { kind: 'ignore' } } // duplicate ready
      return confirm(state, path, false) // in-iframe navigation to another file
    }

    case 'navReset':
      // New splat, same site: forget everything except the generation clock (pre-nav settles must
      // stay stale) and the old path (to recognize its late ready as stale).
      return {
        state: {
          ...initialArbiter<T>(event.expected),
          gen: state.gen,
          staleHint: state.readyPath ?? state.expected,
        },
        decision: { kind: 'none' },
      }
  }
}
