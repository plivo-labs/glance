import { and, eq, lt, or, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { users } from './schema'

// "What's New" read-watermark repo. One column on users (lastSeenReleaseAt); no rows-per-note.
// Pure D1, user-scoped. The write is a single conditional UPDATE — never now(), never a
// read-modify-write — so concurrent /seen calls converge on the larger watermark.

/** The user's watermark (ISO-8601 UTC date), or null if they've never marked anything seen. */
export async function getWatermark(db: DrizzleD1Database, userId: string): Promise<string | null> {
  const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, userId)).limit(1))[0]
  return row?.w ?? null
}

/** Advance the watermark to `throughDate`, clamped to `newest` and never regressing. ONE atomic,
 *  conditional UPDATE — `WHERE id = ? AND (lastSeen IS NULL OR lastSeen < ?)` — so it keeps the
 *  larger of the stored and incoming values without reading first, and races converge. An empty
 *  catalog (newest === null) has nothing to mark seen, so it's a no-op. */
export async function setSeen(
  db: DrizzleD1Database,
  userId: string,
  throughDate: string,
  newest: string | null,
): Promise<void> {
  if (newest === null) return // empty catalog: nothing to see, leave the watermark untouched
  const clamped = throughDate > newest ? newest : throughDate
  await db
    .update(users)
    .set({ lastSeenReleaseAt: clamped })
    .where(and(eq(users.id, userId), or(isNull(users.lastSeenReleaseAt), lt(users.lastSeenReleaseAt, clamped))))
}
