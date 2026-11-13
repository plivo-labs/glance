import { and, eq, isNotNull, lte } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { sites } from '../db/schema'

const MINUTE_MS = 60_000
const UNIT_MS = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS, w: 7 * 24 * 60 * MINUTE_MS } as const
const MAX_EXPIRY_MS = 5 * 365 * UNIT_MS.d

export type ExpiryInput = { kind: 'set'; at: string } | { kind: 'clear' } | { kind: 'invalid'; reason: string }

/**
 * Parses the `expires` value the CLI and the PATCH route share. Relative (`30m`, `12h`, `7d`, `2w`)
 * is resolved HERE, against the server clock, so a skewed laptop clock can't mint a wrong expiry.
 * `YYYY-MM-DD` means the end of that UTC day; a full ISO-8601 instant is taken as given.
 * `none` / `never` / empty clears it. Anything not at least a minute out is refused (it would be
 * dead on arrival), and so is anything more than five years out.
 */
export function parseExpiry(raw: unknown, now: Date = new Date()): ExpiryInput {
  if (raw === null) return { kind: 'clear' }
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'expires must be a string' }
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'none' || v === 'never') return { kind: 'clear' }

  let at: number
  const rel = /^(\d{1,4})([mhdw])$/.exec(v)
  if (rel) {
    at = now.getTime() + Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS]
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    at = Date.parse(`${v}T23:59:59.999Z`)
  } else if (/^\d{4}-\d{2}-\d{2}t/.test(v)) {
    at = Date.parse(v)
  } else {
    return { kind: 'invalid', reason: 'expires must look like 30m, 12h, 7d, 2w, 2026-12-31, an ISO timestamp, or none' }
  }
  if (!Number.isFinite(at)) return { kind: 'invalid', reason: 'expires is not a valid date' }
  if (at < now.getTime() + MINUTE_MS) return { kind: 'invalid', reason: 'expires must be at least a minute in the future' }
  if (at > now.getTime() + MAX_EXPIRY_MS) return { kind: 'invalid', reason: 'expires must be within five years' }
  return { kind: 'set', at: new Date(at).toISOString() }
}

/** True when an `expiresAt` instant has passed. ISO-8601 UTC strings compare correctly as text. */
export function isPastExpiry(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt <= now.toISOString()
}

/** Hourly sweep: flips every active site whose expiresAt has passed to 'expired'. Returns the count. */
export async function expireDueSites(db: DrizzleD1Database, now: Date = new Date()): Promise<number> {
  const flipped = await db
    .update(sites)
    .set({ status: 'expired' })
    .where(and(eq(sites.status, 'active'), isNotNull(sites.expiresAt), lte(sites.expiresAt, now.toISOString())))
    .returning({ id: sites.id })
  return flipped.length
}
