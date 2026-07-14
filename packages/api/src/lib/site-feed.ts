import { sql } from 'drizzle-orm'
import { sites, spaces, type Visibility } from '../db/schema'
import { pureAudioSql } from './site-audio'
import { hasSummarySql } from './site-summary'

export function siteFeedColumns() {
  return {
    id: sites.id,
    spaceSlug: sql<string>`${spaces.slug}`.as('spaceSlug'),
    slug: sites.slug,
    title: sites.title,
    visibility: sites.visibility,
    status: sites.status,
    createdAt: sites.createdAt,
    audio: pureAudioSql(sites.id),
    hasSummary: hasSummarySql(sites.id),
  }
}

type FeedSourceRow = {
  id: string
  spaceSlug: string
  slug: string
  title: string | null
  visibility: Visibility
  status: 'active' | 'archived'
  createdAt: string
  audio: number
  hasSummary: number
}

export function toFeedRow(row: FeedSourceRow, appUrl: string) {
  return {
    id: row.id,
    spaceSlug: row.spaceSlug,
    siteSlug: row.slug,
    title: row.title,
    visibility: row.visibility,
    status: row.status,
    audio: row.audio === 1,
    hasSummary: row.hasSummary === 1,
    url: `${appUrl}/${row.spaceSlug}/${row.slug}`,
    createdAt: row.createdAt,
  }
}
