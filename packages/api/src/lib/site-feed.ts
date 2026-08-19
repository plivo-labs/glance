import { type SQL, type SQLWrapper, or, sql } from 'drizzle-orm'
import { files, siteStars, siteSummaries, sites, spaces, type Visibility } from '../db/schema'
import { AUDIO_EXTENSIONS } from './mime'

// The three correlated scalars below fold per-site flags into a feed's site SELECT. Each is
// EXISTS-based, so it can never multiply site rows or starve a LIMIT the way a raw JOIN would;
// the whole feed stays a single D1 statement. Each carries an explicit `.as(...)` alias because
// real D1 `.batch()` maps result rows by column NAME, and SQLite's name for an unaliased
// expression is undefined — a batched feed statement would come back mangled without it.

// "path is an audio file" as SQL, generated FROM AUDIO_EXTENSIONS so it can't drift from the set the
// content worker serves — a case-insensitive extension match on the final `.<ext>`.
const isAudioPathSql: SQL = or(
  ...[...AUDIO_EXTENSIONS].map((ext) => sql`lower(${files.path}) like ${`%.${ext}`}`),
) as SQL

/**
 * The pure-audio badge (1 = at least one file AND every file audio — flags audio sites in the
 * dashboard feeds with a Mic badge). Costs one bound param per audio extension (via
 * `isAudioPathSql`) — budget for that under D1's 100-param cap when folding it into a chunked
 * `inArray` select.
 */
export function pureAudioSql(siteId: SQLWrapper): SQL.Aliased<number> {
  const siteFiles = (extra: SQL) => sql`exists (select 1 from ${files} where ${files.siteId} = ${siteId}${extra})`
  return sql<number>`(${siteFiles(sql``)} and not ${siteFiles(sql` and not (${isAudioPathSql})`)})`.as('audio')
}

export function hasSummarySql(siteId: SQLWrapper): SQL.Aliased<number> {
  return sql<number>`exists (select 1 from ${siteSummaries} where ${siteSummaries.siteId} = ${siteId})`.as('hasSummary')
}

/**
 * "This CALLER has starred this site". Costs exactly one bound param (`userId`).
 *
 * `userId` is the REQUESTING user, never the row's owner: a star is per-user, and binding the wrong
 * identity here is precisely how one person's stars would light up in everyone else's feed.
 */
export function isStarredSql(siteId: SQLWrapper, userId: string): SQL.Aliased<number> {
  return sql<number>`exists (select 1 from ${siteStars} where ${siteStars.siteId} = ${siteId} and ${siteStars.userId} = ${userId})`.as(
    'starred',
  )
}

/** `userId` is the CALLER's, not the row owner's — `starred` is per-user state riding a shared
 *  feed select, so every call site must pass the requesting user or the flag leaks across users. */
export function siteFeedColumns(userId: string) {
  return {
    id: sites.id,
    spaceSlug: sql<string>`${spaces.slug}`.as('spaceSlug'),
    slug: sites.slug,
    title: sites.title,
    visibility: sites.visibility,
    status: sites.status,
    theme: sites.theme,
    createdAt: sites.createdAt,
    updatedAt: sites.updatedAt,
    audio: pureAudioSql(sites.id),
    hasSummary: hasSummarySql(sites.id),
    starred: isStarredSql(sites.id, userId),
  }
}

type FeedSourceRow = {
  id: string
  spaceSlug: string
  slug: string
  title: string | null
  visibility: Visibility
  status: 'active' | 'archived'
  theme: string | null
  createdAt: string
  updatedAt: string
  audio: number
  hasSummary: number
  starred: number
}

export function toFeedRow(row: FeedSourceRow, appUrl: string) {
  return {
    id: row.id,
    spaceSlug: row.spaceSlug,
    siteSlug: row.slug,
    title: row.title,
    visibility: row.visibility,
    status: row.status,
    theme: row.theme,
    audio: row.audio === 1,
    hasSummary: row.hasSummary === 1,
    starred: row.starred === 1,
    url: `${appUrl}/${row.spaceSlug}/${row.slug}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
