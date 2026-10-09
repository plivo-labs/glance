import { drizzle } from 'drizzle-orm/d1'
import type { ErrorHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from '../types'

/** Round-trips the D1 session bookmark to the browser: sent on responses, echoed back on the
 *  next request so a session anchored at it reads its own prior writes (issue #79). */
export const BOOKMARK_HEADER = 'x-glance-d1-bookmark'

/** D1 calls normally finish in well under a second. During Cloudflare-side D1 incidents a call
 *  hangs ~20-30s and then fails "Network connection lost" (traced 2026-10-09); CloudFront meanwhile
 *  retries the hung origin 3x30s and the user gets a 504 after 90s. Failing the call at this
 *  deadline (mapped to 503 by onError) turns that into a fast error. */
export const D1_DEADLINE_MS = 8000

export class D1DeadlineError extends Error {}

function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new D1DeadlineError(`D1 call exceeded ${ms}ms`)), ms)
  })
  return Promise.race([p, expired]).finally(() => clearTimeout(timer))
}

/** Hono's default handler, plus a 503 for a D1 deadline. Drizzle rethrows driver errors wrapped
 *  in DrizzleQueryError, so the deadline is found by walking the cause chain. */
export const onError: ErrorHandler = (err, c) => {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e instanceof D1DeadlineError) return c.json({ error: 'database_unavailable' }, 503)
  }
  if (err instanceof HTTPException) return err.getResponse()
  console.error(err)
  return c.text('Internal Server Error', 500)
}

// batch() must receive the native statements, so each wrapper remembers the one it wraps.
const unwrapped = new WeakMap<object, D1PreparedStatement>()

function deadlineStatement(stmt: D1PreparedStatement, ms: number): D1PreparedStatement {
  const wrapped = {
    bind: (...values: unknown[]) => deadlineStatement(stmt.bind(...values), ms),
    first: (column?: string) => deadline(column === undefined ? stmt.first() : stmt.first(column), ms),
    all: () => deadline(stmt.all(), ms),
    run: () => deadline(stmt.run(), ms),
    raw: (options?: { columnNames?: boolean }) => deadline(stmt.raw(options as { columnNames: true }), ms),
  } as unknown as D1PreparedStatement
  unwrapped.set(wrapped, stmt)
  return wrapped
}

/** The session with every query and batch bounded by `ms`. */
export function withDeadline(session: D1DatabaseSession, ms = D1_DEADLINE_MS): D1DatabaseSession {
  return {
    prepare: (query: string) => deadlineStatement(session.prepare(query), ms),
    batch: <T>(statements: D1PreparedStatement[]) =>
      deadline(session.batch<T>(statements.map((s) => unwrapped.get(s) ?? s)), ms),
    getBookmark: () => session.getBookmark(),
  }
}

/** Drizzle client over a D1 session so reads route to the nearest replica (read replication).
 *  The cast is required: D1DatabaseSession deliberately omits exec/dump, which drizzle's
 *  D1Database type carries but never calls at runtime. */
export function sessionDb(binding: D1Database, anchor: D1SessionConstraint | D1SessionBookmark) {
  return drizzle(withDeadline(binding.withSession(anchor)) as unknown as D1Database)
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
  c.set('db', drizzle(withDeadline(session) as unknown as D1Database))
  await next()
  const bookmark = session.getBookmark()
  if (bookmark) c.header(BOOKMARK_HEADER, bookmark)
})
