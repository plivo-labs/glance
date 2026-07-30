import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { Context } from 'hono'
import { sessionDb } from '../db/client'
import { apiKeys } from '../db/schema'
import type { AppEnv } from '../types'
import { b64urlEncode } from './hmac'

const enc = new TextEncoder()

export const API_KEY_PREFIX = 'glk_'

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
 *  null (fail closed) rather than throwing. */
export async function resolveApiKey(
  db: DrizzleD1Database,
  secret: string,
): Promise<{ id: string; userId: string; grants: unknown } | null> {
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
  return { id: row.id, userId: row.userId, grants: row.grants }
}

// 'first-primary': withDb defaults to 'first-unconstrained', so a replica could still serve an
// api_keys row that predates a revoke — credential reads must be strongly consistent, not
// eventually. Falls back to c.get('db') so the harness's route tests (which set the db on the
// context directly and bind no GLANCE_DB) keep working.
export function apiKeyDb(c: Context<AppEnv>): DrizzleD1Database {
  return c.env.GLANCE_DB ? sessionDb(c.env.GLANCE_DB, 'first-primary') : c.get('db')
}
