// Shared D1 plumbing: the bind-parameter budget for chunked `inArray` reads, and the batch
// helper every multi-statement round trip goes through.
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { AUDIO_EXTENSIONS } from './mime'

// D1 caps a single statement at 100 bound parameters, so an `inArray` over a large id list must
// be split into chunks and the per-chunk results unioned — otherwise a large member-space /
// shared-site list throws. Kept under 100 to leave room for a statement's other bound values
// (e.g. pureAudioSql's per-audio-extension binds).
export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_MAX_IN = 90

// Chunk size for a SITE FEED that binds an id list — the feeds whose statement carries BOTH an
// `inArray` and the correlated scalars in siteFeedColumns (/shared, /starred). That combination is
// the only place D1's cap actually bites, so the budget is spent explicitly here rather than
// discovered at 101 in production:
//   ids  +  pureAudioSql (one LIKE pattern per audio extension)  +  isStarredSql (the caller's id)
// At D1_MAX_IN the sum was 90 + 8 + 1 = 99 — under the cap, but only by one. The margin is the
// point: it buys room for the next scalar fold, and a spec measures the peak (sites-shared.test.ts).
export const FEED_BIND_MARGIN = 10
const FEED_SCALAR_BINDS = AUDIO_EXTENSIONS.size + 1 // pureAudioSql + isStarredSql
export const FEED_ID_CHUNK = Math.min(D1_MAX_IN, D1_MAX_BOUND_PARAMETERS - FEED_SCALAR_BINDS - FEED_BIND_MARGIN)

/** Split xs into runs of at most `size` (the last run may be shorter). */
export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** `db.batch` over a statement ARRAY: owns the non-empty tuple cast D1's batch signature
 *  demands, so call sites assembling dynamic statement lists don't each repeat it. Empty input is
 *  handled defensively without touching D1; current callers all guard or construct non-empty lists.
 *
 *  TWO RULES bind every statement placed in a batch (here or via raw `db.batch`):
 *  1. Result column names must be UNIQUE and expression columns must carry `.as(...)` — real
 *     D1 maps BATCH rows by column name (loose queries are positional), so a duplicate name
 *     collapses and silently shifts every later field. The test harness throws on name
 *     collisions (batch result-name guard in test/harness.ts makeDb).
 *  2. A statement batched alongside access-facts must be a NON-FAILING SELECT (absent rows →
 *     empty result, never a throw) — one rejected inner statement rejects the whole batch and
 *     destroys the caller's 404/403/410 precedence. */
export async function batchAll<T extends readonly BatchItem<'sqlite'>[]>(
  db: DrizzleD1Database,
  stmts: readonly [...T], // variadic-tuple param, so a literal keeps per-statement result types
): Promise<BatchResponse<T>> {
  if (stmts.length === 0) return [] as unknown as BatchResponse<T>
  return db.batch(stmts as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]) as Promise<BatchResponse<T>>
}

/** Run a READ-ONLY, idempotent D1 round trip, retrying TRANSIENT failures with a short backoff.
 *  D1 occasionally surfaces a transient internal error (and local dev makes them easy to hit:
 *  two `wrangler dev` processes share one --persist-to sqlite, so a concurrent control-plane
 *  write can fail a read with SQLITE_BUSY). Only messages that look transient are retried — a
 *  real query error (bad SQL, missing column) propagates immediately, and a third consecutive
 *  transient failure is an outage, not a flake. Unhappy-path latency ≤300ms. Callers must pass
 *  a thunk that builds statements FRESH per attempt (drizzle builders own their SQL chunks). */
export async function retryTransientRead<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const transient = err instanceof Error && /internal error|SQLITE_BUSY/i.test(err.message)
      if (!transient || attempt >= 2) throw err
      await new Promise((r) => setTimeout(r, [60, 240][attempt]))
    }
  }
}
