// S-D test harness: a real in-memory SQLite (bun:sqlite) wired through drizzle so the
// repo/route helpers run their actual query builders, plus a KV mock matching the
// GLANCE_SESSIONS surface. Cast to the D1 types the app expects — query semantics are
// identical; only the driver differs (D1's `.batch` is shimmed sequentially).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  type NewComment,
  type NewCommentThread,
  type NewEvent,
  type NewFileRow,
  type NewNotification,
  type NewSite,
  type NewSpace,
  type NewUser,
  comments,
  commentThreads,
  events,
  files,
  notifications,
  siteGroupShares,
  siteUserShares,
  sites,
  spaceMembers,
  spaces,
  users,
} from '../db/schema'

const MIGRATIONS = [
  'drizzle/0000_init.sql',
  'drizzle/0001_steep_black_bolt.sql',
  'drizzle/0002_silly_gertrude_yorkes.sql',
  'drizzle/0003_rename_group_visibility.sql',
  'drizzle/0004_drop_public_visibility.sql',
  'drizzle/0005_peaceful_onslaught.sql',
  'drizzle/0006_glance_documents.sql',
  'drizzle/0007_add_indexes.sql',
  'drizzle/0008_comment_audio_key.sql',
  'drizzle/0009_editor_share.sql',
  'drizzle/0010_notifications.sql',
  'drizzle/0011_whats_new_watermark.sql',
  'drizzle/0012_comments_author_index.sql',
  'drizzle/0013_fork_site.sql',
  'drizzle/0014_site_summaries.sql',
  'drizzle/0015_notifications_comment_id.sql',
  'drizzle/0016_notifications_comment_index.sql',
]

// --- S0 recorder: one shared, ordered timeline across D1/R2/cache mocks so perf specs can
// assert exact op INTERLEAVING (e.g. "cache:match before r2:full"), not just per-mock totals.
// Entry scheme: 'd1:batch' | 'd1:stmt' | 'd1:stmt:<insert|update|delete>' | 'r2:<full|ranged|
// head|onlyIf|put>' | 'cache:<match|put|delete>'. Every factory takes the recorder as an
// OPTIONAL param, so existing call sites (makeDb(), makeR2()) keep working unchanged. ---

/** Shared op recorder: ordered `timeline` + per-entry `counters`. `resetCounters()` clears
 *  BOTH (typical use: after seeding, so seed ops are excluded from assertions). */
export function makeRecorder() {
  const timeline: string[] = []
  const counters: Record<string, number> = {}
  return {
    timeline,
    counters,
    record(entry: string) {
      timeline.push(entry)
      counters[entry] = (counters[entry] ?? 0) + 1
    },
    resetCounters() {
      timeline.length = 0
      for (const k of Object.keys(counters)) delete counters[k]
    },
  }
}
export type Recorder = ReturnType<typeof makeRecorder>

/** D1 op counters exposed on the harness db. `loose` = statements executed OUTSIDE a
 *  db.batch; `batchStmts` = statements executed inside one; `insert`/`update`/`delete`
 *  count writes by SQL verb regardless of loose/batch placement. */
export type D1Counters = {
  batches: number
  loose: number
  batchStmts: number
  insert: number
  update: number
  delete: number
}
export type HarnessDb = DrizzleD1Database & { counters: D1Counters; resetCounters: () => void }

// D1 rejects statements binding more than 100 parameters; bun:sqlite happily accepts them,
// which would let an over-wide `inArray` pass in tests and blow up in production. Enforced
// always-on at the statement-execution seam.
const D1_BIND_CAP = 100
const WRITE_VERB_RE = /^\s*(insert|update|delete)\b/i

const newD1Counters = (): D1Counters => ({ batches: 0, loose: 0, batchStmts: 0, insert: 0, update: 0, delete: 0 })

// --- D1 batch result-name guard --------------------------------------------------------------
// Real D1 `.batch()` returns each row as a NAME-KEYED object, and drizzle's d1 driver rebuilds
// the positional row array via Object.keys (`d1ToRawMapping` in drizzle-orm/d1/session.js). Two
// result columns with the same name collapse into ONE key, silently shifting every later field
// (e.g. selecting spaces.slug AND sites.slug emits two columns named "slug"); an unaliased
// expression column gets whatever name SQLite invents — explicitly undefined behavior. LOOSE
// queries are immune: the d1 driver runs them through `stmt.raw()` (positional). bun:sqlite maps
// positionally in both modes, so without this guard the harness can never catch the class.
// Enforced at the statement-execution seam for every SELECT executed inside db.batch.

const IDENT = '"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*'
const IDENT_PATH_RE = new RegExp(`^(?:(?:${IDENT})\\.)*(${IDENT})$`)
const TRAILING_AS_RE = new RegExp(`\\s+as\\s+(${IDENT})\\s*$`, 'i')
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

/** Split a SELECT's top-level result list on commas, tracking paren depth and quote state
 *  (tolerant — doubled-quote escapes toggle twice, which still nets out). Returns the raw item
 *  texts, or null when the statement is not a SELECT. */
function topLevelSelectItems(sqlText: string): string[] | null {
  const m = /^\s*select\s+(?:distinct\s+|all\s+)?/i.exec(sqlText)
  if (!m) return null
  const items: string[] = []
  const end = findTopLevelFrom(sqlText, m[0].length) ?? sqlText.length
  let start = m[0].length
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = start; i < end; i++) {
    const ch = sqlText[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      items.push(sqlText.slice(start, i))
      start = i + 1
    }
  }
  items.push(sqlText.slice(start, end))
  return items.map((x) => x.trim()).filter((x) => x.length > 0)
}

/** Index of the top-level FROM keyword (outside parens/quotes), or null (e.g. `select 1`). */
function findTopLevelFrom(sqlText: string, from: number): number | null {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = from; i < sqlText.length; i++) {
    const ch = sqlText[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && /[\s)]/.test(sqlText[i - 1] ?? ' ') && /^from\b/i.test(sqlText.slice(i))) return i
  }
  return null
}

/** Throw when a SELECT executed inside db.batch would be mangled by real D1's by-name batch row
 *  mapping: duplicate result names, or an expression column with no `AS` alias. */
function assertBatchSelectMapsByName(sqlText: string): void {
  const items = topLevelSelectItems(sqlText)
  if (!items) return // not a SELECT — writes return no result columns
  const seen = new Set<string>()
  for (const item of items) {
    if (item === '*' || item.endsWith('.*')) continue // star: single-table expansion, names are the table's own
    const aliased = TRAILING_AS_RE.exec(item)
    let name: string
    if (aliased) {
      name = unquote(aliased[1])
    } else {
      const path = IDENT_PATH_RE.exec(item)
      if (!path) {
        throw new Error(
          `D1 batch unaliased expression column: \`${item.slice(0, 80)}\` — real D1 batch maps rows by column NAME and SQLite's name for an unaliased expression is undefined; add .as('name'). SQL: ${sqlText.slice(0, 200)}`,
        )
      }
      name = unquote(path[1])
    }
    if (seen.has(name)) {
      throw new Error(
        `D1 batch result-name collision: two columns named "${name}" — real D1 batch maps rows by name and collapses duplicates, shifting every later field; alias one (.as()). SQL: ${sqlText.slice(0, 200)}`,
      )
    }
    seen.add(name)
  }
}

/** Number of values a statement execution binds: drizzle's bun-sqlite driver spreads
 *  positional params (`stmt.all(...params)`); a single plain-object arg is named-param form. */
function bindCount(args: unknown[]): number {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !ArrayBuffer.isView(args[0]))
    return Object.keys(args[0] as object).length
  return args.length
}

/** Fresh in-memory DB with the real schema applied. Every statement execution is observed
 *  (drizzle's bun-sqlite driver funnels through `sqlite.prepare(...)` then
 *  `.run/.all/.get/.values`), feeding `db.counters`, the optional shared recorder, and the
 *  D1 bind-cap guard. Migrations run BEFORE the wrap, so they are never counted; seeds ARE
 *  counted — call `db.resetCounters()` after seeding to exclude them. */
export function makeDb(recorder?: Recorder): HarnessDb {
  const sqlite = new Database(':memory:')
  // Mirror D1, which enforces foreign keys, so dangling-id fixture seeds fail loudly.
  sqlite.run('PRAGMA foreign_keys = ON')
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(import.meta.dir, '../..', file), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }

  const counters = newD1Counters()
  let inBatch = false

  const observe = (sql: string, args: unknown[]) => {
    const bound = bindCount(args)
    if (bound > D1_BIND_CAP)
      throw new Error(`D1 bind-parameter cap exceeded: statement binds ${bound} values (D1 max is ${D1_BIND_CAP})`)
    const verb = WRITE_VERB_RE.exec(sql)?.[1]?.toLowerCase() as 'insert' | 'update' | 'delete' | undefined
    if (verb) counters[verb]++
    if (inBatch) {
      assertBatchSelectMapsByName(sql)
      counters.batchStmts++
    } else counters.loose++
    recorder?.record(verb ? `d1:stmt:${verb}` : 'd1:stmt')
  }

  // Statement-execution seam: wrap prepare() (drizzle's only entry) and shadow the four
  // execution methods on each returned statement instance — the rest of the native
  // Statement surface (columnNames etc.) stays untouched.
  const EXEC_METHODS = ['run', 'all', 'get', 'values'] as const
  const origPrepare = sqlite.prepare.bind(sqlite)
  const wrapStmt = (stmt: ReturnType<typeof origPrepare>, sql: string) => {
    for (const m of EXEC_METHODS) {
      const orig = (stmt[m] as (...a: unknown[]) => unknown).bind(stmt)
      ;(stmt as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        observe(sql, args)
        return orig(...args)
      }
    }
    return stmt
  }
  sqlite.prepare = ((sql: string, ...rest: unknown[]) =>
    wrapStmt((origPrepare as (...a: unknown[]) => ReturnType<typeof origPrepare>)(sql, ...rest), sql)) as never

  const db = drizzle(sqlite) as unknown as HarnessDb & {
    batch(stmts: Promise<unknown>[]): Promise<unknown[]>
  }
  // D1 exposes atomic `.batch`; bun-sqlite does not. Run sequentially (sync driver) so
  // FK-ordered inserts (spaces before space_members) still land in order. Drizzle queries
  // are lazy thenables — they execute when awaited HERE, so the inBatch flag attributes
  // their driver-level statements to the batch (verified in harness.test.ts).
  db.batch = async (stmts) => {
    counters.batches++
    recorder?.record('d1:batch')
    inBatch = true
    try {
      const out: unknown[] = []
      for (const s of stmts) out.push(await s)
      return out
    } finally {
      inBatch = false
    }
  }
  db.counters = counters
  db.resetCounters = () => Object.assign(counters, newD1Counters())
  return db
}

// --- S-SEED: minimal row inserts so route/search specs are authorable. Test-only,
// behavior-preserving; every field defaults to something sensible and overridable. ---

let seedSeq = 0
const nextId = (prefix: string) => `${prefix}-${++seedSeq}`

/** Insert a user; returns its id. Defaults: member role, derived email. */
export async function seedUser(db: DrizzleD1Database, o: Partial<NewUser> = {}): Promise<string> {
  const id = o.id ?? nextId('u')
  await db.insert(users).values({ id, email: o.email ?? `${id}@example.com`, name: o.name ?? null, role: o.role ?? 'member' })
  return id
}

/** Insert a space; returns its id. Defaults: group type, slug/name derived from id. */
export async function seedSpace(db: DrizzleD1Database, o: Partial<NewSpace> & { createdBy: string }): Promise<string> {
  const id = o.id ?? nextId('sp')
  await db
    .insert(spaces)
    .values({ id, slug: o.slug ?? id, name: o.name ?? id, type: o.type ?? 'group', createdBy: o.createdBy })
  return id
}

/** Add a user to a space's membership. */
export async function seedMember(db: DrizzleD1Database, spaceId: string, userId: string): Promise<void> {
  await db.insert(spaceMembers).values({ spaceId, userId })
}

/** Insert a site; returns its id. Defaults: team visibility, active, slug derived from id. */
export async function seedSite(
  db: DrizzleD1Database,
  o: Partial<NewSite> & { spaceId: string; ownerId: string },
): Promise<string> {
  const id = o.id ?? nextId('site')
  await db.insert(sites).values({
    id,
    spaceId: o.spaceId,
    ownerId: o.ownerId,
    slug: o.slug ?? id,
    title: o.title ?? null,
    visibility: o.visibility ?? 'team',
    status: o.status ?? 'active',
    // Omitted → schema $defaultFn (now). Passable so ordering specs can pin exact timelines.
    ...(o.createdAt !== undefined && { createdAt: o.createdAt }),
  })
  return id
}

/** Grant a user a direct (per-user) share on a site. Role defaults to 'viewer' (today's semantics). */
export async function seedUserShare(
  db: DrizzleD1Database,
  siteId: string,
  userId: string,
  role: 'viewer' | 'editor' = 'viewer',
): Promise<void> {
  await db.insert(siteUserShares).values({ siteId, userId, role })
}

/** Grant every member of a (group) space a share on a site. */
export async function seedGroupShare(db: DrizzleD1Database, siteId: string, spaceId: string): Promise<void> {
  await db.insert(siteGroupShares).values({ siteId, spaceId })
}

// --- S-SEED+ : files (+ R2 body), threads, comments. ---

/** Insert a `files` row and, if an R2 mock is given, store its body under the storageKey.
 *  Returns the storageKey so tests can read the same object the row points at. */
export async function seedFile(
  db: DrizzleD1Database,
  r2: { put: (key: string, value: string, opts?: unknown) => Promise<void> } | null,
  siteId: string,
  o: { path: string; text?: string; mimeType?: string; storageKey?: string } & Partial<NewFileRow>,
): Promise<string> {
  const id = o.id ?? nextId('file')
  const storageKey = o.storageKey ?? `${id}/${o.path}`
  const text = o.text ?? ''
  await db.insert(files).values({
    id,
    siteId,
    path: o.path,
    storageKey,
    mimeType: o.mimeType ?? 'text/html',
    size: text.length,
  })
  if (r2) await r2.put(storageKey, text, { httpMetadata: { contentType: o.mimeType ?? 'text/html' } })
  return storageKey
}

/** Insert a `comment_threads` row; returns its id. Defaults: text anchor, open, anchored. */
export async function seedThread(
  db: DrizzleD1Database,
  o: { siteId: string; filePath: string } & Partial<NewCommentThread>,
): Promise<string> {
  const id = o.id ?? nextId('th')
  await db.insert(commentThreads).values({
    id,
    siteId: o.siteId,
    filePath: o.filePath,
    anchorType: o.anchorType ?? 'text',
    anchor: o.anchor ?? null,
    quote: o.quote ?? null,
    contentHash: o.contentHash ?? null,
    anchorStatus: o.anchorStatus ?? 'anchored',
    start: o.start ?? null,
    end: o.end ?? null,
    status: o.status ?? 'open',
    resolvedBy: o.resolvedBy ?? null,
    resolvedAt: o.resolvedAt ?? null,
    createdBy: o.createdBy ?? null,
  })
  return id
}

/** Insert a `comments` row; returns its id. */
export async function seedComment(
  db: DrizzleD1Database,
  o: { threadId: string } & Partial<NewComment>,
): Promise<string> {
  const id = o.id ?? nextId('cm')
  await db.insert(comments).values({
    id,
    threadId: o.threadId,
    authorId: o.authorId ?? null,
    body: o.body ?? 'a comment',
    createdAt: o.createdAt ?? new Date().toISOString(),
    editedAt: o.editedAt ?? null,
    deletedAt: o.deletedAt ?? null,
    audioKey: o.audioKey ?? null,
  })
  return id
}

/** Insert an `events` row; returns its id. Defaults: view type, now. */
export async function seedEvent(db: DrizzleD1Database, o: Partial<NewEvent> = {}): Promise<string> {
  const id = o.id ?? nextId('ev')
  await db.insert(events).values({
    id,
    type: o.type ?? 'view',
    action: o.action ?? null,
    userId: o.userId ?? null,
    siteId: o.siteId ?? null,
    siteLabel: o.siteLabel ?? null,
    cliVersion: o.cliVersion ?? null,
    createdAt: o.createdAt ?? new Date().toISOString(),
  })
  return id
}

/** Insert a `notifications` row; returns its id. Defaults: mention type, unread (readAt null). */
export async function seedNotification(
  db: DrizzleD1Database,
  o: { recipientId: string } & Partial<NewNotification>,
): Promise<string> {
  const id = o.id ?? nextId('nt')
  await db.insert(notifications).values({
    id,
    recipientId: o.recipientId,
    type: o.type ?? 'mention',
    actorId: o.actorId ?? null,
    siteId: o.siteId ?? null,
    siteLabel: o.siteLabel ?? null,
    threadId: o.threadId ?? null,
    commentId: o.commentId ?? null,
    filePath: o.filePath ?? null,
    snippet: o.snippet ?? null,
    readAt: o.readAt ?? null,
    createdAt: o.createdAt ?? new Date().toISOString(),
  })
  return id
}

/** In-memory stand-in for the GLANCE_SESSIONS KV namespace (get/put/delete + ttl peek). */
export function makeKv() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value)
      ttls.set(key, options?.expirationTtl)
      return Promise.resolve()
    },
    delete: (key: string) => {
      store.delete(key)
      ttls.delete(key)
      return Promise.resolve()
    },
    store,
    ttls,
  }
}

/** Wrap a KV mock (default a fresh `makeKv()`) to COUNT get/put/delete ops — `makeKv` exposes
 *  store/ttls but no counters, and specs like "token absent → zero KV ops" or "cache hit → no
 *  put" need the count. `failNextPut(err)` makes exactly the next put reject (the op is still
 *  counted — it was issued, it just failed), proving a KV put failure doesn't abort delivery.
 *  Re-exposes the inner `store`/`ttls` so ttl assertions keep working. */
export function countingKv(inner = makeKv()) {
  const ops = { get: 0, put: 0, delete: 0 }
  let nextPutError: unknown = null
  return {
    get: (key: string) => {
      ops.get++
      return inner.get(key)
    },
    put: (key: string, value: string, options?: { expirationTtl?: number }) => {
      ops.put++
      if (nextPutError != null) {
        const err = nextPutError
        nextPutError = null
        return Promise.reject(err)
      }
      return inner.put(key, value, options)
    },
    delete: (key: string) => {
      ops.delete++
      return inner.delete(key)
    },
    store: inner.store,
    ttls: inner.ttls,
    ops: () => ({ ...ops }),
    failNextPut(err: unknown) {
      nextPutError = err
    },
  }
}

/** R2's 3 range shapes (`{offset, length?}` / `{offset?, length}` / `{suffix}`), sliced on
 *  BYTES. `size` on the returned object is always the FULL object size — matching real R2
 *  (`R2Object.size` is unaffected by the requested range) — so callers must slice the body,
 *  not the reported size. */
function sliceRange(
  bytes: Uint8Array,
  range: { offset?: number; length?: number; suffix?: number } | undefined,
): Uint8Array {
  if (!range) return bytes
  const total = bytes.length
  if ('suffix' in range && range.suffix != null) return bytes.slice(Math.max(0, total - range.suffix))
  const start = range.offset ?? 0
  const end = range.length != null ? start + range.length : total
  return bytes.slice(start, end)
}

/** Coerce every R2 put body shape to owned bytes: string → UTF-8 encode; ArrayBuffer /
 *  ArrayBufferView → copied bytes; ReadableStream → collected bytes. */
async function toBytes(value: string | ReadableStream | ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  if (value && typeof (value as ReadableStream).getReader === 'function')
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer())
  return new Uint8Array()
}

/** Etag comparison the way real R2 tolerates client forms: strip a weak `W/` prefix and
 *  surrounding quotes, compare the opaque value. */
function normalizeEtag(etag: string): string {
  const strong = etag.startsWith('W/') ? etag.slice(2) : etag
  return strong.length >= 2 && strong.startsWith('"') && strong.endsWith('"') ? strong.slice(1, -1) : strong
}

type R2Conditional = { etagMatches?: string | string[]; etagDoesNotMatch?: string | string[] }

/** R2Conditional check (etag conditions only — uploadedBefore/After are out of scope here).
 *  All present conditions must hold, matching real R2. */
function etagConditionsHold(onlyIf: R2Conditional, currentEtag: string): boolean {
  const current = normalizeEtag(currentEtag)
  const list = (x: string | string[]) => (Array.isArray(x) ? x : [x]).map(normalizeEtag)
  if (onlyIf.etagMatches != null && !list(onlyIf.etagMatches).includes(current)) return false
  if (onlyIf.etagDoesNotMatch != null && list(onlyIf.etagDoesNotMatch).includes(current)) return false
  return true
}

/** In-memory stand-in for the GLANCE_FILES R2 bucket with a TRUE BYTE model: bodies are
 *  stored as Uint8Array (string puts UTF-8-encoded), ranges slice bytes, `size` is always
 *  the full BYTE length, and `httpEtag` ROTATES on every put of the same key (quoted,
 *  version-suffixed — real R2 etags change when content changes; rotating unconditionally
 *  keeps stale-etag tests honest even for same-body re-puts).
 *
 *  `get` returns `body` (Uint8Array — a valid BodyInit), `text()` (UTF-8 decode of the
 *  sliced bytes), `arrayBuffer()`, `size`, `httpEtag`, `httpMetadata`. With `onlyIf`
 *  ({etagMatches}/{etagDoesNotMatch}, string or array, weak/quoted forms tolerated), a
 *  FAILED precondition resolves to a body-LESS object (mirroring real R2: R2Object, not
 *  R2ObjectBody — no body/text/arrayBuffer keys) so callers can distinguish "precondition
 *  failed" (metadata only) from "missing" (null). `head(key)` returns the same body-less
 *  shape. Per-kind counters via `ops()` → {full, ranged, head, onlyIf} (a get with BOTH
 *  onlyIf and range counts as onlyIf); the legacy `gets()` total counts every get() call
 *  (full + ranged + onlyIf — head excluded). Feeds the shared recorder when given one. */
export function makeR2(recorder?: Recorder) {
  const store = new Map<string, { body: Uint8Array; httpMetadata?: { contentType?: string }; httpEtag: string }>()
  const versions = new Map<string, number>() // survives delete → an etag is never reused
  const ops = { full: 0, ranged: 0, head: 0, onlyIf: 0 }
  const meta = (key: string, v: { body: Uint8Array; httpMetadata?: { contentType?: string }; httpEtag: string }) => ({
    key,
    size: v.body.length,
    httpEtag: v.httpEtag,
    httpMetadata: v.httpMetadata,
  })
  return {
    get: (
      key: string,
      options?: {
        range?: { offset?: number; length?: number; suffix?: number }
        onlyIf?: R2Conditional
      },
    ) => {
      const kind = options?.onlyIf ? 'onlyIf' : options?.range ? 'ranged' : 'full'
      ops[kind]++
      recorder?.record(`r2:${kind}`)
      const v = store.get(key)
      if (!v) return Promise.resolve(null)
      // Failed precondition → R2Object (metadata only), NOT R2ObjectBody: no body/text/arrayBuffer.
      if (options?.onlyIf && !etagConditionsHold(options.onlyIf, v.httpEtag)) return Promise.resolve(meta(key, v))
      const body = sliceRange(v.body, options?.range)
      return Promise.resolve({
        ...meta(key, v),
        body,
        text: () => Promise.resolve(new TextDecoder().decode(body)),
        arrayBuffer: () => Promise.resolve(body.slice().buffer),
      })
    },
    head: (key: string) => {
      ops.head++
      recorder?.record('r2:head')
      const v = store.get(key)
      return Promise.resolve(v ? meta(key, v) : null)
    },
    put: async (
      key: string,
      value: string | ReadableStream | ArrayBuffer | ArrayBufferView,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      const version = (versions.get(key) ?? 0) + 1
      versions.set(key, version)
      store.set(key, { body: await toBytes(value), httpMetadata: options?.httpMetadata, httpEtag: `"${key}-v${version}"` })
      recorder?.record('r2:put')
    },
    delete: (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
      return Promise.resolve()
    },
    store,
    ops: () => ({ ...ops }),
    gets: () => ops.full + ops.ranged + ops.onlyIf,
  }
}

/** In-memory stand-in for the Workers Cache API (`caches.default.{match,put,delete}`,
 *  Request|string keys — string keys must be absolute URLs, like the real API). `put`
 *  reads from a CLONE, so the caller's response body stays readable; `match` mints a
 *  FRESH Response per call (bytes + headers + status), readable every time. Counters:
 *  {matches, puts, hits, misses}. `failNextMatch(err)`/`failNextPut(err)` make exactly
 *  the next call reject (the attempt is still counted and recorded — the op was issued,
 *  it just failed); `reset()` clears store, counters, and pending failures. */
export function makeCaches(recorder?: Recorder) {
  const store = new Map<string, { body: Uint8Array; status: number; statusText: string; headers: [string, string][] }>()
  const newCounters = () => ({ matches: 0, puts: 0, hits: 0, misses: 0 })
  const counters = newCounters()
  let nextMatchError: unknown = null
  let nextPutError: unknown = null
  const keyOf = (key: Request | string | URL) => (key instanceof Request ? key.url : new URL(String(key)).href)
  return {
    default: {
      match: async (key: Request | string | URL): Promise<Response | undefined> => {
        counters.matches++
        recorder?.record('cache:match')
        if (nextMatchError != null) {
          const err = nextMatchError
          nextMatchError = null
          throw err
        }
        const entry = store.get(keyOf(key))
        if (!entry) {
          counters.misses++
          return undefined
        }
        counters.hits++
        const body = entry.status === 204 || entry.status === 304 ? null : entry.body.slice()
        return new Response(body, { status: entry.status, statusText: entry.statusText, headers: entry.headers })
      },
      put: async (key: Request | string | URL, response: Response): Promise<void> => {
        counters.puts++
        recorder?.record('cache:put')
        if (nextPutError != null) {
          const err = nextPutError
          nextPutError = null
          throw err
        }
        // Store from a clone: the caller keeps a readable body (real cache.put contract).
        const body = new Uint8Array(await response.clone().arrayBuffer())
        store.set(keyOf(key), {
          body,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
        })
      },
      delete: async (key: Request | string | URL): Promise<boolean> => {
        recorder?.record('cache:delete')
        return store.delete(keyOf(key))
      },
    },
    store,
    counters,
    failNextMatch(err: unknown) {
      nextMatchError = err
    },
    failNextPut(err: unknown) {
      nextPutError = err
    },
    reset() {
      store.clear()
      Object.assign(counters, newCounters())
      nextMatchError = null
      nextPutError = null
    },
  }
}
