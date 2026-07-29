import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import type { Site } from '../db/schema'
import { siteStars } from '../db/schema'

/**
 * The one rule stars add on top of `checkAccess`: a `private` site is never starrable — not even
 * by its owner. A star pins something you come back to through a shared surface, and private has
 * none. Named because it is enforced at two layers with opposite polarity — the toggle REFUSES a
 * private site (400), and the feed FILTERS one out at read time (an owner's own private site
 * passes checkAccess, so the feed would otherwise resurface it after a visibility flip).
 */
export function isStarrable(site: Pick<Site, 'visibility'>): boolean {
  return site.visibility !== 'private'
}

/**
 * "This CALLER has starred this site" as ONE correlated scalar a feed folds into its site SELECT,
 * the same shape as pureAudioSql / hasSummarySql — EXISTS-based, so it can never multiply site rows
 * or starve a LIMIT, and the whole feed stays a single D1 statement. Costs exactly one bound param
 * (`userId`) — budget for it under D1's 100-param cap when folding into a chunked `inArray` select.
 *
 * `userId` is the REQUESTING user, never the row's owner: a star is per-user, and binding the wrong
 * identity here is precisely how one person's stars would light up in everyone else's feed. Carries
 * an explicit `AS "starred"` alias because real D1 `.batch()` maps result rows by column NAME.
 */
export function isStarredSql(siteId: SQLWrapper, userId: string): SQL.Aliased<number> {
  return sql<number>`exists (select 1 from ${siteStars} where ${siteStars.siteId} = ${siteId} and ${siteStars.userId} = ${userId})`.as(
    'starred',
  )
}
