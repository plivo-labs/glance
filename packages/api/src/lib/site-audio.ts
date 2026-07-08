import { type SQL, inArray, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { files } from '../db/schema'
import { AUDIO_EXTENSIONS } from './mime'

// D1 caps a statement at 100 bound params; keep the id list per query well under that.
const D1_MAX_IN = 90

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

// "path is an audio file" as SQL, generated FROM AUDIO_EXTENSIONS so it can't drift from the set the
// content worker serves — a case-insensitive extension match on the final `.<ext>`.
const isAudioPathSql: SQL = or(
  ...[...AUDIO_EXTENSIONS].map((ext) => sql`lower(${files.path}) like ${`%.${ext}`}`),
) as SQL

/**
 * Of the given sites, which are pure-audio — every file an audio type (by extension, the same
 * authority the content worker serves by) AND at least one file. Flags audio sites in the dashboard
 * feeds with a Mic badge. One GROUP BY per chunk returns COUNT(*) + an audio-count per site — O(sites)
 * rows, never the full file list — so a feed with big HTML sites doesn't drag every path into memory.
 */
export async function allAudioSiteIds(db: DrizzleD1Database, siteIds: string[]): Promise<Set<string>> {
  if (siteIds.length === 0) return new Set()
  const out = new Set<string>()
  for (const ids of chunk(siteIds, D1_MAX_IN)) {
    const rows = await db
      .select({
        siteId: files.siteId,
        total: sql<number>`count(*)`,
        audio: sql<number>`sum(case when ${isAudioPathSql} then 1 else 0 end)`,
      })
      .from(files)
      .where(inArray(files.siteId, ids))
      .groupBy(files.siteId)
    for (const r of rows) if (r.total > 0 && r.total === r.audio) out.add(r.siteId)
  }
  return out
}
