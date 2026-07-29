import { type SQL, and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { type ChangeLogRow, type ChangeType, changeLog, documents } from '../db/schema'

// Statement factories for the per-site change stream. Each one is a BatchItem the mutation route
// drops into ITS OWN db.batch, so the log row and the documents write commit together — a push
// that outlives its log row is an event no reconnecting client can ever replay.
//
// TWO SHAPES, one rule: the log statement always runs FIRST in the batch, because it reads the
// PRE-mutation state (a delete's row is still there; a fresh-id put has not landed yet). Every
// factory RETURNs the committed row, so the caller gets the assigned seq — and, for a delete, the
// DOCUMENT's creator — with no second read. An EMPTY result is the honest "nothing was written"
// signal that suppresses a phantom push.

/** One committed mutation, in exactly the shape a fan-out filter needs: `collection` + the
 *  DOCUMENT's `createdBy` are what canViewerRead asks for, so no socket needs a second read. */
export type ChangeEvent = {
  siteId: string
  seq: number
  collection: string
  docId: string
  createdBy: string
  type: ChangeType
  at: string
}

/** The literal columns of a log row, in the table's declaration order — drizzle's insert-select
 *  emits `insert into change_log (<every column>) <select>`, so the select list must line up. */
type ChangeInput = Omit<ChangeEvent, 'seq'>

const RETURNING = {
  siteId: changeLog.siteId,
  seq: changeLog.seq,
  collection: changeLog.collection,
  docId: changeLog.docId,
  createdBy: changeLog.createdBy,
  type: changeLog.type,
  at: changeLog.at,
}

/** Next per-site seq as a SQL expression, so the counter is read and bumped inside the mutation's
 *  own transaction — the `sql\`${sites.contentVersion} + 1\`` idiom, scoped by siteId. */
function nextSeq(siteId: string): SQL {
  return sql`(select coalesce(max(${changeLog.seq}), 0) + 1 from ${changeLog} where ${changeLog.siteId} = ${siteId})`
}

function row(e: ChangeInput): SQL {
  return sql`select ${e.siteId}, ${nextSeq(e.siteId)}, ${e.collection}, ${e.docId}, ${e.createdBy}, ${e.type}, ${e.at}`
}

function logStmt(db: DrizzleD1Database, select: SQL) {
  return db.insert(changeLog).select(select).returning(RETURNING)
}

/** Log a mutation that is certain to happen (a server-id create, or an update whose row was just
 *  read back). Always writes exactly one row. */
export function logChangeStmt(db: DrizzleD1Database, e: ChangeInput) {
  return logStmt(db, row(e))
}

/** Log a caller-chosen-id create ONLY if that id is still free. PUT's insert is race-guarded with
 *  `onConflictDoNothing`, so an unconditional log would emit a phantom 'create' — attributed to
 *  the LOSER of the race, whose row never landed — whenever a concurrent first-PUT won. This runs
 *  before the insert in the same batch, so its NOT EXISTS and the unique index agree exactly. */
export function logCreateIfAbsentStmt(db: DrizzleD1Database, e: ChangeInput) {
  return logStmt(
    db,
    sql`${row(e)} where not exists (select 1 from ${documents}
      where ${documents.siteId} = ${e.siteId}
        and ${documents.collection} = ${e.collection}
        and ${documents.docId} = ${e.docId})`,
  )
}

/** Log a delete by SELECTING the row that is about to disappear, using the delete's OWN predicate
 *  — so the log can never disagree with what was removed. This is how the DOCUMENT's creator
 *  survives a moderating delete by the owner (constraint 7), and why a delete that matched zero
 *  rows logs nothing and therefore pushes nothing. */
export function logDeletedStmt(db: DrizzleD1Database, siteId: string, at: string, where: SQL | undefined) {
  return logStmt(
    db,
    sql`select ${documents.siteId}, ${nextSeq(siteId)}, ${documents.collection}, ${documents.docId},
      ${documents.createdBy}, 'delete', ${at} from ${documents} where ${where}`,
  )
}

/** A change as a client sees it — REPLAYED by the catch-up endpoint or PUSHED by the SiteRoom,
 *  deliberately the same shape so a page's onCreate cannot tell live from replay. `id` is the docId
 *  (the id `toDoc` exposes), and `seq` is DROPPED: the raw per-site sequence is the site's whole
 *  mutation count, and its gaps alone would tell a viewer how many documents they cannot see just
 *  changed. It leaves the server only sealed inside a cursor. */
export function toEvent(row: Omit<ChangeEvent, 'siteId' | 'seq'>) {
  return { type: row.type, collection: row.collection, id: row.docId, createdBy: row.createdBy, at: row.at }
}

// --- Replay reads (the catch-up endpoint's half) ---

/** Rows above `afterSeq` for ONE site, oldest first — the composite PK (siteId, seq) IS this scan's
 *  index. Returns the raw rows, seq included: the caller filters them through the read policy and
 *  strips the seq before anything reaches a client. */
export function changesAfter(
  db: DrizzleD1Database,
  siteId: string,
  afterSeq: number,
  limit: number,
): Promise<ChangeLogRow[]> {
  return db
    .select()
    .from(changeLog)
    .where(and(eq(changeLog.siteId, siteId), gt(changeLog.seq, afterSeq)))
    .orderBy(asc(changeLog.seq))
    .limit(limit)
}

/** The site's current head position, 0 when it has never been written. A top-1 descending scan
 *  rather than max(seq), so the statement stays a plain column select (D1 maps BATCH result rows
 *  by column NAME, and an unaliased aggregate has none). */
export async function currentSeq(db: DrizzleD1Database, siteId: string): Promise<number> {
  const [row] = await db
    .select({ seq: changeLog.seq })
    .from(changeLog)
    .where(eq(changeLog.siteId, siteId))
    .orderBy(desc(changeLog.seq))
    .limit(1)
  return row?.seq ?? 0
}
