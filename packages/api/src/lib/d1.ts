// Shared D1 plumbing: the bind-parameter budget for chunked `inArray` reads, and the batch
// helper every multi-statement round trip goes through.
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

// D1 caps a single statement at 100 bound parameters, so an `inArray` over a large id list must
// be split into chunks and the per-chunk results unioned — otherwise a large member-space /
// shared-site list throws. Kept under 100 to leave room for a statement's other bound values
// (e.g. pureAudioSql's per-audio-extension binds).
export const D1_MAX_IN = 90

/** Split xs into runs of at most `size` (the last run may be shorter). */
export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** `db.batch` over a statement ARRAY: owns the non-empty tuple cast D1's batch signature
 *  demands, so call sites assembling dynamic statement lists don't each repeat it. Empty input
 *  resolves to `[]` without touching D1 (a zero-statement batch would throw; no current call
 *  site can produce one, so this is a safe no-op rather than a reachable branch). */
export async function batchAll<T extends readonly BatchItem<'sqlite'>[]>(
  db: DrizzleD1Database,
  stmts: readonly [...T], // variadic-tuple param, so a literal keeps per-statement result types
): Promise<BatchResponse<T>> {
  if (stmts.length === 0) return [] as unknown as BatchResponse<T>
  return db.batch(stmts as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]) as Promise<BatchResponse<T>>
}
