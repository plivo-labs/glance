import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { Context } from 'hono'
import { sessionDb } from '../db/client'
import { apiKeys } from '../db/schema'
import type { AppEnv } from '../types'
import type { DataCapability } from './data-token'
import { b64urlEncode } from './hmac'

const enc = new TextEncoder()

export const API_KEY_PREFIX = 'glk_'

// Throttle window for the lastUsedAt touch (see touchApiKeyLastUsed below): a key hammered once a
// second would otherwise cost 86,400 D1 row-writes/day just for "last used 4m ago" in the UI.
export const LAST_USED_THROTTLE_MS = 60 * 60 * 1000

// The api_keys.grants JSON blob, now that its shape is settled. `control` may drive the control
// plane (deploy, list, fork...) — site DELETE is denied to keys regardless (see routes/sites.ts).
// `data: null` means the key cannot mint data tokens at all; otherwise `scope` allowlists which
// sites it may mint for and `caps` ceilings what a minted token can carry (routes/data.ts
// intersects this against the caller's own access — narrower wins on both sides).
export type ApiKeyGrants = {
  control: boolean
  data: { scope: { kind: 'all-owned' } | { kind: 'sites'; siteIds: string[] }; caps: DataCapability[] } | null
}

function isDataScope(v: unknown): v is ApiKeyGrants['data'] & object {
  if (typeof v !== 'object' || v === null) return false
  const scope = (v as { scope?: unknown }).scope
  const caps = (v as { caps?: unknown }).caps
  if (!Array.isArray(caps) || !caps.every((c) => typeof c === 'string')) return false
  if (typeof scope !== 'object' || scope === null) return false
  const kind = (scope as { kind?: unknown }).kind
  if (kind === 'all-owned') return true
  if (kind === 'sites') {
    const siteIds = (scope as { siteIds?: unknown }).siteIds
    return Array.isArray(siteIds) && siteIds.every((id) => typeof id === 'string')
  }
  return false
}

/** Narrow runtime validator for the grants shape (not a schema library) — resolveApiKey fails
 *  closed on anything that doesn't match, same as an unparseable blob. Exported so the mint route
 *  (routes/api-keys.ts) rejects a malformed `grants` body with the SAME check, rather than a
 *  second, driftable one. */
export function isApiKeyGrants(v: unknown): v is ApiKeyGrants {
  if (typeof v !== 'object' || v === null) return false
  const g = v as { control?: unknown; data?: unknown }
  if (typeof g.control !== 'boolean') return false
  return g.data === null || isDataScope(g.data)
}

/** Mint a fresh control-plane API key secret: 32 CSPRNG bytes, base64url (no padding), prefixed
 *  so a key is recognizable at a glance (and greppable in logs — never log the full value). The
 *  plaintext is returned to the caller ONCE; only its hash is ever persisted. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return API_KEY_PREFIX + b64urlEncode(bytes.buffer as ArrayBuffer)
}

/** Plain SHA-256 hex, no salt, no KDF iteration. Unlike a password, this secret is already 256
 *  bits of CSPRNG entropy — a slow KDF (bcrypt/scrypt/argon2) buys nothing against brute force
 *  here and would only add latency to every authenticated request. */
export async function hashApiKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Resolve a presented secret to its LIVE key row (revokedAt IS NULL, not expired), or null.
 *  The expiry compare binds a JS-side `new Date().toISOString()` as a parameter rather than
 *  using SQLite's `datetime('now')` — that function emits 'YYYY-MM-DD HH:MM:SS' (space
 *  separator) while `expiresAt` is stored 'YYYY-MM-DDTHH:MM:SS.sssZ'. A lexical compare between
 *  the two FAILS OPEN for a key expiring later the same day, because 'T' (0x54) sorts after
 *  the space (0x20): '2026-07-31T00:00:00.000Z' > '2026-07-31 12:00:00' is true, so an
 *  already-expired-today key would still authenticate. An unparseable `grants` blob resolves to
 *  null (fail closed) rather than throwing — and so does a parseable blob that doesn't match
 *  `ApiKeyGrants` (a shape check, since the column is untyped JSON at rest). */
export async function resolveApiKey(
  db: DrizzleD1Database,
  secret: string,
): Promise<{ id: string; userId: string; grants: ApiKeyGrants; lastUsedAt: string | null } | null> {
  const hash = await hashApiKey(secret)
  const now = new Date().toISOString()
  let row: typeof apiKeys.$inferSelect | undefined
  try {
    // drizzle's json-mode column JSON.parses `grants` while mapping the row — a corrupt blob
    // throws HERE, inside the select, not after; caught below so it fails closed.
    ;[row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, now)))
  } catch {
    return null
  }
  if (!row) return null
  if (!isApiKeyGrants(row.grants)) return null
  return { id: row.id, userId: row.userId, grants: row.grants, lastUsedAt: row.lastUsedAt }
}

/** Best-effort `lastUsedAt` touch, throttled to LAST_USED_THROTTLE_MS: a no-op when the stored
 *  value is already within the window, so a hot key costs one D1 write per hour rather than one
 *  per request. NEVER throws — same "swallow it" contract as recordEvent (lib/events.ts), since
 *  a failed touch must not turn an authenticated request into an error. Callers hand the
 *  resulting promise to fireAndForget so the write itself rides off the response's critical path. */
export async function touchApiKeyLastUsed(db: DrizzleD1Database, id: string, lastUsedAt: string | null): Promise<void> {
  if (lastUsedAt !== null && Date.now() - new Date(lastUsedAt).getTime() < LAST_USED_THROTTLE_MS) return
  try {
    await db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKeys.id, id))
  } catch {
    // Swallow — a failed touch must never surface to the caller.
  }
}

/** Revoke every LIVE key (revokedAt IS NULL) a user holds — the D1 counterpart to
 *  `revokeUserCliTokens` (KV), called alongside it from the offboarding kill-switch. Idempotent:
 *  the WHERE simply matches nothing on a second call or for a user with no keys. */
export async function revokeUserApiKeys(db: DrizzleD1Database, userId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
}

// 'first-primary': withDb defaults to 'first-unconstrained', so a replica could still serve an
// api_keys row that predates a revoke — credential reads must be strongly consistent, not
// eventually. Falls back to c.get('db') so the harness's route tests (which set the db on the
// context directly and bind no GLANCE_DB) keep working.
export function apiKeyDb(c: Context<AppEnv>): DrizzleD1Database {
  return c.env.GLANCE_DB ? sessionDb(c.env.GLANCE_DB, 'first-primary') : c.get('db')
}
