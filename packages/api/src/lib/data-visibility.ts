import { type DataClaims, hasCap } from './data-token'

// The ONE per-document read policy for `glance.db`. It lives here — not inside the SQL builder in
// routes/data.ts — because a realtime push is a SECOND read path: whoever decides which sockets
// receive an event must ask the SAME question the SELECT asks, or a fan-out becomes an IDOR.
// Everything else (the drizzle creator wall, any push filter) DERIVES from these two functions.
//
//   default        → your own rows (createdBy = token viewerId)
//   `shared-*`     → opt-in by naming convention: readable by EVERY authorized site viewer
//   `read_all` cap → owner/superadmin sees every row regardless of creator
//
// Writes are unaffected: put/delete stay creator-scoped (see `scoped()` in routes/data.ts).
const SHARED_PREFIX = 'shared-'

// Only the fields the policy actually reads, so a hibernated socket's attachment (which stores a
// claims SNAPSHOT, never the bearer token) can be passed straight in.
export type ReadClaims = Pick<DataClaims, 'viewerId' | 'caps'>

/**
 * True when this (token, collection) pair drops the per-creator wall entirely — i.e. the read is
 * creator-independent. This is the half a SQL WHERE clause can express, so the query builder
 * derives from it instead of restating the policy.
 */
export function readsEveryCreator(claims: ReadClaims, collection: string): boolean {
  return collection.startsWith(SHARED_PREFIX) || hasCap(claims, 'read_all')
}

/** True iff `claims` may read a document in `collection` created by `createdBy`. */
export function canViewerRead(claims: ReadClaims, collection: string, createdBy: string): boolean {
  return readsEveryCreator(claims, collection) || createdBy === claims.viewerId
}
