import type { Release } from './bake'
import { RELEASES } from './catalog'

// Pure, in-memory reads over the baked catalog — NO SQL, NO D1. The only per-user state is the
// watermark, which the caller supplies. "unread" is a release strictly NEWER than the watermark;
// a null watermark means the user has seen nothing, so everything is unread.

/** The full release archive, already sorted newest-first at build time. */
export function listReleases(): Release[] {
  return RELEASES
}

/** How many of `releases` are unread given a watermark. Strictly `>` so a watermark sitting exactly
 *  on the newest release date reads as 0 unread (not 1). null watermark → all of them. Pure over
 *  the passed list so it's testable with any constructed catalog, independent of the baked one. */
export function countUnread(releases: readonly { date: string }[], watermark: string | null): number {
  if (watermark === null) return releases.length
  return releases.reduce((n, r) => n + (r.date > watermark ? 1 : 0), 0)
}

/** Unread count over the BAKED catalog for a given watermark (what the route serves). */
export function unreadCount(watermark: string | null): number {
  return countUnread(RELEASES, watermark)
}
