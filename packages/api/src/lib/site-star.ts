import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import { siteStars } from '../db/schema'

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
