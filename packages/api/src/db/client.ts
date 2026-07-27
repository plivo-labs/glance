import { drizzle } from 'drizzle-orm/d1'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

/** Round-trips the D1 session bookmark to the browser: sent on responses, echoed back on the
 *  next request so a session anchored at it reads its own prior writes (issue #79). */
export const BOOKMARK_HEADER = 'x-glance-d1-bookmark'

/** Drizzle client over a D1 session so reads route to the nearest replica (read replication).
 *  The cast is required: D1DatabaseSession deliberately omits exec/dump, which drizzle's
 *  D1Database type carries but never calls at runtime. */
export function sessionDb(binding: D1Database, anchor: D1SessionConstraint | D1SessionBookmark) {
  return drizzle(binding.withSession(anchor) as unknown as D1Database)
}

// Per-request drizzle client — the D1 binding is request-scoped in Workers, so the
// client must not be memoized across requests. Attaches c.get('db').
//
// The client runs over a D1 session (not the bare binding) so reads route to the nearest
// replica once read replication is enabled. Anchoring at the browser-echoed bookmark keeps
// cross-request read-your-write consistency; without one, 'first-unconstrained' lets even
// the first query hit a replica.
export const withDb = createMiddleware<AppEnv>(async (c, next) => {
  const session = c.env.GLANCE_DB.withSession(c.req.header(BOOKMARK_HEADER) ?? 'first-unconstrained')
  c.set('db', drizzle(session as unknown as D1Database))
  await next()
  const bookmark = session.getBookmark()
  if (bookmark) c.header(BOOKMARK_HEADER, bookmark)
})
