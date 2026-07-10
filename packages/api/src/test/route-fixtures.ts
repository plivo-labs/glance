// Shared fixtures for ROUTE tests (sites-*/spaces): the app is mounted the way index.ts wires it
// (same-origin guard + db injection + both route groups), env carries the KV/R2 mocks, and the
// Bearer-token auth path is real. A superset of the per-file makeApp twins it replaced — an extra
// mounted route group or env binding is inert for tests that never touch it.
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { comments } from '../routes/comments'
import { sites } from '../routes/sites'
import { spaces } from '../routes/spaces'
import type { AppEnv } from '../types'
import { makeDb, makeKv, makeR2, seedUser } from './harness'

export const APP_URL = 'https://glance.example.com'

/** App + env + mocks, production-shaped. Destructure what the test needs. */
export function makeRouteApp() {
  const db = makeDb()
  const kv = makeKv()
  const r2 = makeR2()
  const env = {
    APP_URL,
    SESSION_SECRET: 's',
    CONTENT_URL: 'https://content.example.com',
    CONTENT_TOKEN_SECRET: 'content-secret',
    GLANCE_SESSIONS: kv,
    GLANCE_FILES: r2,
  } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)
  app.route('/api/spaces', spaces)
  // Same order as index.ts: sites first, then comments on the same mount (3-segment paths).
  app.route('/api/sites', comments)
  return { app, env, db, kv, r2 }
}

export type RouteApp = ReturnType<typeof makeRouteApp>

/** Seed a user row AND a live CLI session token (`Bearer tok-<id>`) in one shot. */
export async function mintUser(
  db: RouteApp['db'],
  kv: RouteApp['kv'],
  id: string,
  opts: { role?: 'member' | 'superadmin'; email?: string } = {},
): Promise<string> {
  const role = opts.role ?? 'member'
  const email = opts.email ?? `${id}@example.com`
  await seedUser(db, { id, email, role })
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email, name: null, role }))
  return id
}

/** Request headers authenticating as `mintUser(id)` through the same-origin guard. */
export const auth = (id: string) => ({
  Authorization: `Bearer tok-${id}`,
  Origin: APP_URL,
  'Content-Type': 'application/json',
})

/** Post-auth D1 request count. A "request" is one D1 round trip: a loose statement or one
 *  db.batch. requireAuth itself costs exactly 1 loose read (getUserById) — subtract it;
 *  everything after is the handler. (The single place this invariant is documented.) */
export const postAuthRequests = (db: RouteApp['db']) => db.counters.loose - 1 + db.counters.batches

/** Deterministic createdAt, strictly increasing with i, so expected payloads are hand-codable. */
export const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
