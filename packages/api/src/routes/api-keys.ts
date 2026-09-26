import { and, count, desc, eq, gt, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { apiKeys as apiKeysTable } from '../db/schema'
import { API_KEY_PREFIX, generateApiKey, hashApiKey, isApiKeyGrants } from '../lib/api-key'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// Self-service control-plane API keys, mounted at /api/api-keys. Every route is scoped to the
// CALLER's own keys (c.get('user').id) — there is no admin surface here to manage anyone else's.

const MAX_NAME_LENGTH = 200

// The only expiries a key may be minted with. `expiresAt` is ALWAYS derived server-side from one
// of these — a body-supplied `expiresAt` is never read, so a client can never name its own expiry.
export const KEY_DURATIONS = [1, 7, 30, 90, 180, 365] as const

// Per-user cap on ACTIVE keys (revokedAt IS NULL AND not expired). Expired and revoked keys are
// tombstones, not active, so they never count against it — revoking one frees a slot immediately.
export const MAX_ACTIVE_KEYS = 10

export const apiKeys = new Hono<AppEnv>()
apiKeys.use('*', requireAuth)

// Same not-expired predicate style as resolveApiKey (lib/api-key.ts): a JS-side ISO instant bound
// as a parameter, never SQLite's `datetime('now')` (see that file's comment for why the lexical
// compare between the two formats fails open for a same-day expiry).
function activeKeyCount(db: DrizzleD1Database, userId: string) {
  const now = new Date().toISOString()
  return db
    .select({ n: count() })
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.userId, userId), isNull(apiKeysTable.revokedAt), gt(apiKeysTable.expiresAt, now)))
}

// POST / — mint a fresh key. Returns the plaintext secret EXACTLY ONCE; only its hash is stored.
apiKeys.post('/', async (c) => {
  // A key may never mint another key regardless of its grants — otherwise a leaked key mints a
  // backdoor key that outlives revocation of the leaked one (same "denied regardless" pattern as
  // site DELETE in routes/sites.ts).
  if (c.get('credential').kind === 'key') return c.json({ error: 'forbidden' }, 403)

  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown
    expiresInDays?: unknown
    grants?: unknown
  } | null

  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: 'name is required' }, 400)

  const expiresInDays = body?.expiresInDays
  if (typeof expiresInDays !== 'number' || !KEY_DURATIONS.includes(expiresInDays as (typeof KEY_DURATIONS)[number])) {
    return c.json({ error: `expiresInDays must be one of ${KEY_DURATIONS.join(', ')}` }, 400)
  }

  const grants = body?.grants
  if (!isApiKeyGrants(grants)) return c.json({ error: 'invalid grants' }, 400)

  const db = c.get('db')
  const user = c.get('user')

  const [{ n: activeCount }] = await activeKeyCount(db, user.id)
  if (activeCount >= MAX_ACTIVE_KEYS) {
    return c.json({ error: `active key limit reached (max ${MAX_ACTIVE_KEYS})` }, 400)
  }

  const secret = generateApiKey()
  const hash = await hashApiKey(secret)
  const now = new Date()
  // expiresAt is computed HERE, from the fixed duration set only — any `expiresAt` in the body is
  // never read above, so it cannot influence this value.
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
  const id = crypto.randomUUID()
  await db.insert(apiKeysTable).values({
    id,
    userId: user.id,
    name,
    hash,
    grants,
    createdAt: now.toISOString(),
    expiresAt,
    // Non-secret display fragment: the last 4 chars of the plaintext ONLY (see schema.ts comment
    // on `displaySuffix` — never enough to be useful to an attacker).
    displaySuffix: secret.slice(-4),
  })

  return c.json(
    { id, name, secret, grants, createdAt: now.toISOString(), expiresAt },
    201,
    // The secret is shown exactly once, in this response — never cache it.
    { 'Cache-Control': 'no-store' },
  )
})

// GET / — the caller's own keys, newest first. Revoked and expired rows stay (tombstone model,
// not a hard delete) so the UI can still show them. Never returns `hash` or anything the secret
// could be derived from.
apiKeys.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: apiKeysTable.id,
      name: apiKeysTable.name,
      grants: apiKeysTable.grants,
      createdAt: apiKeysTable.createdAt,
      expiresAt: apiKeysTable.expiresAt,
      revokedAt: apiKeysTable.revokedAt,
      lastUsedAt: apiKeysTable.lastUsedAt,
      displaySuffix: apiKeysTable.displaySuffix,
    })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.userId, c.get('user').id))
    .orderBy(desc(apiKeysTable.createdAt))

  return c.json({
    items: rows.map(({ displaySuffix, ...row }) =>
      Object.assign(row, { secretHint: displaySuffix ? `${API_KEY_PREFIX}…${displaySuffix}` : null }),
    ),
  })
})

// DELETE /:id — revoke. Idempotent: revoking an already-revoked key is still a success. A key
// that isn't the caller's own 404s (not 403 — a 403 would confirm the id exists at all).
apiKeys.delete('/:id', async (c) => {
  // A key may never revoke a key — checked BEFORE the ownership lookup so a key learns nothing
  // about which ids exist, and so a leaked key can't be used to revoke the user's OTHER keys.
  if (c.get('credential').kind === 'key') return c.json({ error: 'forbidden' }, 403)

  const id = c.req.param('id')
  const db = c.get('db')
  const [row] = await db
    .select({ id: apiKeysTable.id })
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, c.get('user').id)))
  if (!row) return c.json({ error: 'not found' }, 404)

  await db.update(apiKeysTable).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeysTable.id, id))
  return c.json({ revoked: true })
})
