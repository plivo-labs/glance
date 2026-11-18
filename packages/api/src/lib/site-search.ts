// Full-text search over page content (migration 0032). `site_text` holds one row per site: the
// visible text of its html/md files. `site_search` is an external-content FTS5 index over it that
// triggers keep in step (inserts, deletes AND FK cascades), so this module only ever writes
// `site_text`. Every query joins back to `sites`, so access is decided by the live site row, never
// by these tables. This module owns the SQL: building the text, writing it (as batch statements, so
// it commits WITH the file swap), the injection-safe MATCH string, snippets, and the cron backfill.
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { files, sites } from '../db/schema'
import { batchAll } from './d1'
import { cap, extractText, isSupportedEntry, resolveIndexPath } from './extract'

// Query-builder handles. Not in db/schema.ts on purpose: drizzle-kit would try to `CREATE TABLE` the
// virtual table, and nothing outside this feature needs them.
// `id` is left off siteText on purpose: it is DB-assigned, and drizzle's insert-select wants the
// handle's columns to be exactly the ones selected.
export const siteText = sqliteTable('site_text', { siteId: text('siteId').notNull(), body: text('body').notNull() })
export const siteSearch = sqliteTable('site_search', { body: text('body') })
/** Join key FROM site_search TO site_text: the FTS hit's rowid is `site_text.id`. */
export const searchHitJoin = sql`"site_text"."id" = "site_search"."rowid"`
/** bm25 rank of the hit (lower = better). Valid only in a query FROM site_search. */
export const searchRank = sql<number>`"site_search"."rank"`

export const SEARCH_TEXT_CAP = 200_000 // chars of text kept per site
// extractText already caps each FILE at 40k chars; these bound how many files get read, and how much
// of each, so a huge upload (or a cron tick) cannot spend unbounded CPU or memory on indexing.
export const UPLOAD_INDEX_MAX_FILES = 50
export const READ_BYTES_PER_FILE = 1024 * 1024
// ... and this bounds the TOTAL: 50 files x 1 MiB would still be two HTMLRewriter passes over 50 MiB.
// 4 MiB of page source per upload, and 4 MiB per backfill tick shared by all its sites. It counts
// bytes READ, not text kept (markup-heavy pages yield little text but cost the same to scan), and
// each read is cut to what is left. Source past the budget is simply not indexed: an upload still
// succeeds and keeps what it indexed, but is left unstamped so the backfill (its own budget) takes
// the site. A backfill site cut by it keeps what fit and stays unstamped; if it had the whole budget
// to itself that counts as an attempt, so a site bigger than the budget is retried
// BACKFILL_MAX_ATTEMPTS times at most (one that only ran out of what earlier sites left just waits).
export const SEARCH_SOURCE_BUDGET = 4 * 1024 * 1024
// The hourly backfill runs inside one invocation with a small subrequest budget (the free plan
// allows 50): per site that is 1 file-list read + one R2 get per file + 1 batch.
export const BACKFILL_SITES_PER_TICK = 4
export const BACKFILL_MAX_FILES = 8
// A site whose backfill fails this many times is skipped from then on (until an upload resets it),
// and the queue runs fewest attempts first: a site that always fails must not hold the head of the
// newest-first queue and starve every older site behind it.
export const BACKFILL_MAX_ATTEMPTS = 3

type Candidate = { path: string; mimeType: string | null }

/** Most useful text first, so the cap drops the tail: the root-served entry, then the rest by path. */
function indexOrder<T extends Candidate>(candidates: T[]): T[] {
  const entry = resolveIndexPath(candidates.map((c) => c.path))
  return candidates
    .filter((c) => isSupportedEntry(c))
    .sort((a, b) => Number(b.path === entry) - Number(a.path === entry) || a.path.localeCompare(b.path))
}

/** The searchable text of a site: visible text of its html/md files, entry first, joined and capped.
 *  `read` returns the first `maxBytes` of a file, or null when it is unavailable. Every byte read is
 *  charged to `budget`; once it is spent, no more files are read. */
export async function buildSearchText<T extends Candidate>(
  candidates: T[],
  read: (c: T, maxBytes: number) => Promise<ArrayBuffer | null>,
  maxFiles: number,
  budget: { left: number },
): Promise<string> {
  const parts: string[] = []
  let length = 0
  for (const c of indexOrder(candidates).slice(0, maxFiles)) {
    if (budget.left <= 0) break
    const source = await read(c, Math.min(READ_BYTES_PER_FILE, budget.left))
    if (source === null) continue
    budget.left -= source.byteLength
    const extracted = await extractText(c, new TextDecoder().decode(source))
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

/** Index text and stamp for an upload's in-memory files. Never rejects: no stamp means "not fully
 *  indexed", which the caller records as such so the cron backfill picks the site up — an index
 *  fault (text null) or a spent budget (the text that fit) must not fail an upload that is fine. */
export async function searchTextFromUpload(
  items: { path: string; file: File }[],
): Promise<{ text: string | null; indexedAt: string | null }> {
  const budget = { left: SEARCH_SOURCE_BUDGET }
  try {
    const text = await buildSearchText(
      items.map(({ path, file }) => ({ path, mimeType: file.type || null, file })),
      (c, maxBytes) => c.file.slice(0, maxBytes).arrayBuffer(),
      UPLOAD_INDEX_MAX_FILES,
      budget,
    )
    return { text, indexedAt: budget.left > 0 ? new Date().toISOString() : null }
  } catch (err) {
    console.error('searchTextFromUpload: indexing failed', { error: String(err) })
    return { text: null, indexedAt: null }
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

/**
 * The MATCH expression for a user query, or null when there is nothing worth searching. Only
 * letter/number/mark runs survive and each becomes a quoted FTS5 string, so no operator, column
 * filter, NEAR or unbalanced quote can reach the parser (a `"` cannot occur inside a token).
 * Tokens AND together; the last one is a prefix match once it has 3+ characters (search-as-you-type).
 */
export function ftsMatchQuery(q: string): string | null {
  const tokens = (q.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).slice(0, 6)
  if (!tokens.some((t) => t.length >= 2)) return null
  return tokens.map((t, i) => (i === tokens.length - 1 && t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(' ')
}

// snippet()'s last argument counts TOKENS, so a page of very long words could still return kilobytes.
export const SNIPPET_CAP = 300 // chars

/** One line, capped to SNIPPET_CAP chars (never splitting a surrogate pair), with an ellipsis when cut. */
export function tidySnippet(raw: string): string {
  const { text, truncated } = cap(raw.replace(/\s+/g, ' ').trim(), SNIPPET_CAP)
  return truncated ? `${text}…` : text
}

/** The FTS5 snippet column for content hits: an excerpt around the match, read in the same statement
 *  (so the same snapshot) that the caller's access filter runs in. Pass the raw value to tidySnippet. */
export const searchSnippet = sql<string>`snippet("site_search", 0, '', '', '…', 16)`

/**
 * One cron tick of the backfill: index a few not-yet-indexed sites (fewest failed attempts first,
 * then newest) by reading their html/md files from R2. Bounded — BACKFILL_SITES_PER_TICK sites,
 * BACKFILL_MAX_FILES reads each, the first READ_BYTES_PER_FILE of every file, SEARCH_SOURCE_BUDGET
 * bytes in all: once the budget is spent the tick ends, leaving the rest of its sites untouched. The
 * write only lands if the site is still at the content version we read and still unindexed, so a
 * replace racing the tick wins: its own batch has already written fresh rows and a stale read can
 * never overwrite them. Text is upserted, because an upload that ran out of budget leaves a partial
 * row, and only ever grows (a cut tick must not shrink a longer row). A site that fails, or is cut
 * while it had the whole budget, is retried on a later tick behind sites with fewer attempts until
 * it has used BACKFILL_MAX_ATTEMPTS. Returns how many sites it wrote.
 */
export async function backfillSiteSearch(db: DrizzleD1Database, bucket: R2Bucket): Promise<number> {
  const pending = await db
    .select({ id: sites.id, contentVersion: sites.contentVersion })
    .from(sites)
    .where(and(isNull(sites.searchIndexedAt), lt(sites.searchAttempts, BACKFILL_MAX_ATTEMPTS)))
    .orderBy(asc(sites.searchAttempts), desc(sites.updatedAt))
    .limit(BACKFILL_SITES_PER_TICK)
  const budget = { left: SEARCH_SOURCE_BUDGET }
  const failedTry = sql`${sites.searchAttempts} + 1`
  let processed = 0
  for (const site of pending) {
    if (budget.left <= 0) break
    const alone = budget.left === SEARCH_SOURCE_BUDGET // no earlier site spent any of it
    // Gates the write AND a failure count: both only apply to the content version we read.
    const unchanged = and(eq(sites.id, site.id), eq(sites.contentVersion, site.contentVersion), isNull(sites.searchIndexedAt))
    try {
      const rows = await db
        .select({ path: files.path, storageKey: files.storageKey, mimeType: files.mimeType })
        .from(files)
        .where(eq(files.siteId, site.id))
      const body = await buildSearchText(
        rows,
        async (f, maxBytes) => {
          const object = await bucket.get(f.storageKey, { range: { offset: 0, length: maxBytes } })
          return object ? object.arrayBuffer() : null
        },
        BACKFILL_MAX_FILES,
        budget,
      )
      const cut = budget.left <= 0
      // A cut site stays unstamped, and is charged an attempt only if it was cut alone: one that just
      // ran out of what earlier sites left is not at fault, and reaches the head of the queue as they
      // finish or fall behind.
      const mark = !cut ? { searchIndexedAt: new Date().toISOString() } : alone ? { searchAttempts: failedTry } : null
      await batchAll(db, [
        ...(body
          ? [
              db
                .insert(siteText)
                .select(
                  db
                    .select({ siteId: sql<string>`${site.id}`.as('siteId'), body: sql<string>`${body}`.as('body') })
                    .from(sites)
                    .where(unchanged),
                )
                .onConflictDoUpdate({
                  target: siteText.siteId,
                  set: { body: sql`excluded.body` },
                  setWhere: sql`length(excluded.body) > length(${siteText.body})`,
                }),
            ]
          : []),
        ...(mark ? [db.update(sites).set(mark).where(unchanged)] : []),
      ])
      processed++
    } catch (err) {
      console.error('backfillSiteSearch: site failed', { siteId: site.id, error: String(err) })
      // The fault may be D1 itself, so recording the failure must not end the tick.
      await db
        .update(sites)
        .set({ searchAttempts: failedTry })
        .where(unchanged)
        .catch((e) => console.error('backfillSiteSearch: failure not recorded', { siteId: site.id, error: String(e) }))
    }
  }
  return processed
}
