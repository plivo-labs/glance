import { sql } from 'drizzle-orm'
import { sites, spaces, type Visibility } from '../db/schema'
import { pureAudioSql } from './site-audio'
import { isStarredSql } from './site-star'
import { hasSummarySql } from './site-summary'

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
