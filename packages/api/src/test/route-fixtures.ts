// Shared fixtures for ROUTE tests (sites-*/spaces): the app is mounted the way index.ts wires it
// (same-origin guard + db injection + both route groups), env carries the KV/R2 mocks, and the
// Bearer-token auth path is real. A superset of the per-file makeApp twins it replaced — an extra
// mounted route group or env binding is inert for tests that never touch it.
import { Hono } from 'hono'
import { generateApiKey, hashApiKey } from '../lib/api-key'
import { requireSameOrigin } from '../middleware/auth'
import { admin } from '../routes/admin'
import { apiKeys } from '../routes/api-keys'
import { commentFeed } from '../routes/comment-feed'
import { comments } from '../routes/comments'
import { summary } from '../routes/summary'
import { sites } from '../routes/sites'
import { slackEvents } from '../routes/slack-events'
import { spaces } from '../routes/spaces'
import { stars } from '../routes/stars'
import type { AppEnv } from '../types'
import type { ApiKeyGrants } from '../lib/api-key'
import { makeDb, makeKv, makeR2, seedApiKey, seedUser } from './harness'

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
  // Before comments/summary — see index.ts: their wildcard requireAuth would otherwise run first.
  app.route('/api/sites', stars)
  app.route('/api/spaces', spaces)
  // Same order as index.ts: sites first, then comments on the same mount (3-segment paths).
  app.route('/api/sites', comments)
  app.route('/api/sites', summary)
  app.route('/api/comments', commentFeed)
  app.route('/api/slack', slackEvents)
  app.route('/api/api-keys', apiKeys)
  app.route('/api/admin', admin)
  return { app, env, db, kv, r2 }
}

/** Slack's request signature for a raw body — `v0:{ts}:{body}` HMAC'd with the signing secret, hex,
 *  `v0=`-prefixed. Derived independently of lib/slack-verify so route tests exercise the real
 *  algorithm rather than replaying the implementation. */
export async function signSlack(secret: string, body: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  return `v0=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')}`
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
  // The per-user index entry `createCliToken` writes alongside the token. Without it the fixture
  // looks authenticated but is invisible to `revokeUserCliTokens`, which enumerates this prefix —
  // so the offboarding kill-switch could not be tested at all, and a regression that stopped
  // revoking CLI tokens would have shipped green.
  await kv.put(`cli_index:${id}:tok-${id}`, '')
  return id
}

/** Request headers carrying a raw Bearer token through the same-origin guard — used directly with
 *  `mintKey(...)`'s plaintext API key secret. */
export const authKey = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Origin: APP_URL,
  'Content-Type': 'application/json',
})

/** Request headers authenticating as `mintUser(id)`'s CLI token. */
export const auth = (id: string) => authKey(`tok-${id}`)

/** Seed a live `glk_`-prefixed API key for an EXISTING user (mint their session/CLI identity
 *  first via `mintUser`), returning the plaintext secret to send as a Bearer token. Defaults to
 *  FULL_GRANTS; pass `grants` to mint a narrower key (e.g. `control: false`). */
export async function mintKey(
  db: RouteApp['db'],
  userId: string,
  grants?: ApiKeyGrants,
): Promise<string> {
  const secret = generateApiKey()
  await seedApiKey(db, { userId, hash: await hashApiKey(secret), ...(grants && { grants }) })
  return secret
}

/** A key that may use the DATA plane but must not change control-plane state — the "data only"
 *  key from the plan's wireframe, and the one `requireControlGrant` exists to constrain. */
export const DATA_ONLY_GRANTS: ApiKeyGrants = {
  control: false,
  data: { scope: { kind: 'all-owned' }, caps: ['read', 'create'] },
}

/** Post-auth D1 request count. A "request" is one D1 round trip: a loose statement or one
 *  db.batch. requireAuth itself costs exactly 1 loose read (getUserById) — subtract it;
 *  everything after is the handler. (The single place this invariant is documented.) */
export const postAuthRequests = (db: RouteApp['db']) => db.counters.loose - 1 + db.counters.batches

/** Deterministic createdAt, strictly increasing with i, so expected payloads are hand-codable. */
export const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
