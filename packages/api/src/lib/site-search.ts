// Full-text search over page content (migration 0032). `site_text` holds one row per site: the
// visible text of its html/md files. `site_search` is an external-content FTS5 index over it that
// triggers keep in step (inserts, deletes AND FK cascades), so this module only ever writes
// `site_text`. Every query joins back to `sites`, so access is decided by the live site row, never
// by these tables. This module owns the SQL: building the text, writing it (as batch statements, so
// it commits WITH the file swap).
import { eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { extractText, isSupportedEntry, resolveIndexPath } from './extract'

// Query-builder handles. Not in db/schema.ts on purpose: drizzle-kit would try to `CREATE TABLE` the
// virtual table, and nothing outside this feature needs them.
// `id` is left off siteText on purpose: it is DB-assigned, and drizzle's insert-select wants the
// handle's columns to be exactly the ones selected.
export const siteText = sqliteTable('site_text', { siteId: text('siteId').notNull(), body: text('body').notNull() })

export const SEARCH_TEXT_CAP = 200_000 // chars of text kept per site
// extractText already caps each FILE at 40k chars; these bound how many files get read, and how much
// of each, so a huge upload (or a cron tick) cannot spend unbounded CPU or memory on indexing.
export const UPLOAD_INDEX_MAX_FILES = 50
export const READ_BYTES_PER_FILE = 1024 * 1024
type Candidate = { path: string; mimeType: string | null }

/** Most useful text first, so the cap drops the tail: the root-served entry, then the rest by path. */
function indexOrder<T extends Candidate>(candidates: T[]): T[] {
  const entry = resolveIndexPath(candidates.map((c) => c.path))
  return candidates
    .filter((c) => isSupportedEntry(c))
    .sort((a, b) => Number(b.path === entry) - Number(a.path === entry) || a.path.localeCompare(b.path))
}

/** The searchable text of a site: visible text of its html/md files, entry first, joined and capped.
 *  `read` returns a file's (possibly truncated) source, or null when it is unavailable. */
export async function buildSearchText<T extends Candidate>(
  candidates: T[],
  read: (c: T) => Promise<string | null>,
  maxFiles: number,
): Promise<string> {
  const parts: string[] = []
  let length = 0
  for (const c of indexOrder(candidates).slice(0, maxFiles)) {
    const source = await read(c)
    if (source === null) continue
    const extracted = await extractText(c, source)
    if (!extracted.ok) continue
    parts.push(extracted.text)
    length += extracted.text.length + 1
    if (length >= SEARCH_TEXT_CAP) break
  }
  const joined = parts.join('\n')
  if (joined.length <= SEARCH_TEXT_CAP) return joined
  const capped = joined.slice(0, SEARCH_TEXT_CAP)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}

/** Index text for an upload's in-memory files. Never rejects: null means "could not index", which
 *  the caller records as not-indexed so the cron backfill retries — an index fault must not fail an
 *  upload that is otherwise fine. */
export async function searchTextFromUpload(items: { path: string; file: File }[]): Promise<string | null> {
  try {
    return await buildSearchText(
      items.map(({ path, file }) => ({ path, mimeType: file.type || null, file })),
      (c) => c.file.slice(0, READ_BYTES_PER_FILE).text(),
      UPLOAD_INDEX_MAX_FILES,
    )
  } catch (err) {
    console.error('searchTextFromUpload: indexing failed', { error: String(err) })
    return null
  }
}

/** Replace a site's searchable text. DELETE then INSERT (never INSERT OR REPLACE — see the
 *  migration): the triggers keep the FTS index in step. Empty/null text leaves no row. */
export function searchRowStmts(db: DrizzleD1Database, siteId: string, body: string | null): BatchItem<'sqlite'>[] {
  return [
    db.delete(siteText).where(eq(siteText.siteId, siteId)),
    ...(body ? [db.insert(siteText).values({ siteId, body })] : []),
  ]
}

/** A fork's text, copied from the source's in the fork's own batch (the bytes are copied, so the
 *  text is identical). */
export const copySearchRowStmt = (db: DrizzleD1Database, fromSiteId: string, toSiteId: string) =>
  db
    .insert(siteText)
    .select(
      db
        .select({ siteId: sql<string>`${toSiteId}`.as('siteId'), body: siteText.body })
        .from(siteText)
        .where(eq(siteText.siteId, fromSiteId)),
    )
