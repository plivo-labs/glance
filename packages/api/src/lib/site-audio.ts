import { type SQL, type SQLWrapper, or, sql } from 'drizzle-orm'
import { files } from '../db/schema'
import { AUDIO_EXTENSIONS } from './mime'

// "path is an audio file" as SQL, generated FROM AUDIO_EXTENSIONS so it can't drift from the set the
// content worker serves — a case-insensitive extension match on the final `.<ext>`.
const isAudioPathSql: SQL = or(
  ...[...AUDIO_EXTENSIONS].map((ext) => sql`lower(${files.path}) like ${`%.${ext}`}`),
) as SQL

/**
 * The pure-audio badge as ONE correlated scalar a feed can fold into its site SELECT (1 = at
 * least one file AND every file audio — flags audio sites in the dashboard feeds with a Mic
 * badge). EXISTS-based, so it can never multiply site rows or starve a LIMIT the way a raw
 * files JOIN would; the whole feed stays a single D1 statement. Costs one bound param per
 * audio extension (via `isAudioPathSql`) — budget for that under D1's 100-param cap when
 * folding it into a chunked `inArray` select. Carries an explicit `AS "audio"` alias: real D1
 * `.batch()` maps result rows by column NAME, and SQLite's name for an unaliased expression is
 * undefined — a batched feed statement would come back mangled without it.
 */
export function pureAudioSql(siteId: SQLWrapper): SQL.Aliased<number> {
  const siteFiles = (extra: SQL) => sql`exists (select 1 from ${files} where ${files.siteId} = ${siteId}${extra})`
  return sql<number>`(${siteFiles(sql``)} and not ${siteFiles(sql` and not (${isAudioPathSql})`)})`.as('audio')
}
