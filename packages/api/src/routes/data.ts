import { and, count, desc, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { type Context, Hono } from 'hono'
import { sessionDb } from '../db/client'
import { type ChangeLogRow, type DocumentRow, type Site, documents, sites } from '../db/schema'
import { type DataCapability, type DataClaims, hasCap, signDataToken, verifyDataToken } from '../lib/data-token'
import { canViewerRead, readsEveryCreator } from '../lib/data-visibility'
import { authorizeViewerById, fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { requireAuth } from '../middleware/auth'
import {
  changesAfter,
  currentSeq,
  logChangeStmt,
  logCreateIfAbsentStmt,
  logDeletedStmt,
  toEvent,
} from '../realtime/change-log'
import { decodeCursor, encodeCursor } from '../realtime/cursor'
import { notifyChange } from '../realtime/notify'
import { TOKEN_HEADER, WS_PROTOCOL } from '../realtime/protocol'
import { isUpgrade, reissueUpgrade, subprotocols } from '../realtime/upgrade'
import type { AppEnv, Bindings, SessionUser } from '../types'

// The shared-backend data plane (`glance.db`). Two surfaces:
//   • dataApi  (this file → mounted at /api/_data, BEFORE the /api/* same-origin+cookie guards):
//     bearer-token-only, exact-origin CORS, its own per-request DB — callable cross-origin from
//     the content origin, never touching the app session cookie.
//   • dataToken (→ mounted at /api/data-token, under the normal guards): session-authenticated
//     mint that the TRUSTED app exchanges a site for a short-lived data token.
// Every security-critical value (siteId, viewer identity, capabilities) is derived from the
// verified token — never from a client-supplied request field.

const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/
const DOCID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_JSON_BYTES = 100_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
// Per-site document quota: a modest DoS guard so an authorized viewer cannot create unbounded
// rows (forms/polls are viewer-writable). Exported so the boundary is unit-tested directly.
export const MAX_DOCS_PER_SITE = 5000
const DATA_TOKEN_TTL_SEC = 300
// Rows scanned per catch-up call. The cursor advances past every scanned row, so a client behind
// by more than this pages forward on the `more` flag below — a bounded response, never an
// unbounded replay. Exported so the page boundary is exercised directly.
export const MAX_CHANGES = 200

// `db` is optional: production runs no middleware that sets it, so getDb() falls back to a
// per-request client from the D1 binding; tests inject the in-memory harness db via c.set('db')
// — the same seam the content worker uses. `token` is the raw verified credential, kept only so
// the WebSocket upgrade can re-present it to the Durable Object, which re-verifies it itself.
type DataEnv = {
  Bindings: Bindings
  Variables: { db?: DrizzleD1Database; claims: DataClaims; token: string; secret: string }
}
type DataCtx = Context<DataEnv>

// 'first-primary': the auth middleware's site lookup is always the session's first query, so it
// anchors the session at the primary's current state — an SDK create followed by a list stays
// read-your-write with no client-side bookmark threading (the SDK/broker never see D1 headers).
// Later queries in the request still ride replicas consistent with that anchor.
function getDb(c: DataCtx): DrizzleD1Database {
  return c.get('db') ?? sessionDb(c.env.GLANCE_DB, 'first-primary')
}

export const dataApi = new Hono<DataEnv>()

// Exact-origin, credential-less CORS. ACAO is pinned to CONTENT_URL (never reflected back from
// the request Origin) and NO Access-Control-Allow-Credentials is emitted, so a browser never
// attaches the app session cookie to these routes — the bearer data token is the only authority.
// Inert (404) when DATA_TOKEN_SECRET is unset, so the feature is opt-in per deploy.
dataApi.use('*', async (c, next) => {
  // Narrowed ONCE here and carried as a variable: every downstream use is then a plain string, so
  // the "secret is set" invariant is expressed by the type instead of re-asserted by a cast.
  const secret = c.env.DATA_TOKEN_SECRET
  if (!secret) return c.text('Not found', 404)
  c.set('secret', secret)
  c.header('Access-Control-Allow-Origin', c.env.CONTENT_URL)
  c.header('Vary', 'Origin')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  c.header('Access-Control-Max-Age', '600')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// Verify the bearer data token, then LIVE re-authorize against current DB state via the same
// authorizeViewerById the content worker uses, so a revoked share, tightened visibility,
// archived site, or deleted user blocks data access immediately — the token is never trusted
// as a standalone snapshot.
dataApi.use('*', async (c, next) => {
  const token = credential(c)
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  const claims = await verifyDataToken(c.get('secret'), token)
  if (!claims) return c.json({ error: 'unauthorized' }, 401)

  const db = getDb(c)
  const site = (
    await db
      .select({
        id: sites.id,
        spaceId: sites.spaceId,
        visibility: sites.visibility,
        status: sites.status,
        ownerId: sites.ownerId,
      })
      .from(sites)
      .where(eq(sites.id, claims.siteId))
      .limit(1)
  )[0]
  if (!site) return c.json({ error: 'forbidden' }, 403)

  const { access } = await authorizeViewerById(db, site, claims.viewerId)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  c.set('db', db)
  c.set('claims', claims)
  c.set('token', token)
  await next()
})

// --- Upgrade credential ---

// `isUpgrade`/`subprotocols` live in realtime/upgrade.ts: routes/comments.ts's own socket route
// reads the very same offer, so the pair is shared machinery rather than a copy per route.

// The subprotocol credential counts ONLY on a real upgrade, so no ordinary request on this surface
// gains a second way to authenticate.
function credential(c: DataCtx): string | null {
  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  if (!isUpgrade(c)) return null
  const [sentinel, token] = subprotocols(c)
  return sentinel === WS_PROTOCOL && token ? token : null
}

// Method → required capability, enforced structurally for every current AND future route on
// this surface — a new endpoint cannot ship without a capability check. POST maps to `create`
// (every viewer may submit attributed documents); PUT/DELETE stay behind `write` (owner-only).
const METHOD_CAP: Record<string, DataCapability> = { GET: 'read', HEAD: 'read', POST: 'create', PUT: 'write', DELETE: 'write' }
dataApi.use('*', async (c, next) => {
  const cap = METHOD_CAP[c.req.method]
  if (!cap || !hasCap(c.get('claims'), cap)) return c.json({ error: 'forbidden' }, 403)
  await next()
})

// Catch-up replay. Registered BEFORE the /:collection routes so the static segment wins — a
// document collection literally named `_sync` must not be able to shadow the change feed.
//
// A missing cursor means "from now": the caller gets an empty backlog and a position, which is
// what a page subscribing for the first time wants. A cursor that fails to decode is a hard 400,
// never a silent fall back to 0 — that would replay a site's entire history to anyone who
// scribbles on the query string.
dataApi.get('/_sync/changes', async (c) => {
  const claims = c.get('claims')
  const secret = c.get('secret')
  const db = getDb(c)

  const raw = c.req.query('cursor')
  let from: number
  if (raw === undefined || raw === '') {
    from = await currentSeq(db, claims.siteId)
  } else {
    const cursor = await decodeCursor(secret, raw)
    // The cursor's identity is INSIDE the ciphertext and must equal the verified token's, so a
    // cursor cannot be lifted from one viewer (or one site) and replayed as another.
    if (!cursor || cursor.siteId !== claims.siteId || cursor.viewerId !== claims.viewerId) {
      return c.json({ error: 'invalid cursor' }, 400)
    }
    from = cursor.seq
  }

  const rows = await changesAfter(db, claims.siteId, from, MAX_CHANGES)
  // The SAME predicate the GET routes ask, against the DOCUMENT's creator — a push (or a replay)
  // is a second read path, so the policy is asked, never restated.
  const events = rows.filter((r) => canViewerRead(claims, r.collection, r.createdBy)).map(toEvent)
  // The new position advances past every row SCANNED, not every row returned: the filtered-out
  // rows must never be re-examined, and the client is told nothing about how many there were.
  const seq = rows.length > 0 ? (rows[rows.length - 1] as ChangeLogRow).seq : from
  return c.json({
    events,
    cursor: await encodeCursor(secret, { siteId: claims.siteId, viewerId: claims.viewerId, seq }),
    // A FULL page means the scan stopped at the limit, not at the head. Without this the caller
    // has no way to know: the cursor has already advanced past every scanned row, so whatever
    // lies beyond them is never requested by anyone and the page goes permanently stale. It is
    // a boolean, never a count — "keep paging", not how many rows the viewer could not see.
    more: rows.length === MAX_CHANGES,
  })
})

// Realtime subscribe. Registered beside /_sync/changes (before the /:collection routes) so it
// inherits the whole data-plane gate: inert 404 without DATA_TOKEN_SECRET, a verified token, a
// LIVE re-authorization against current DB state, and METHOD_CAP's GET→`read`. All of that runs
// BEFORE the Durable Object is addressed, so junk, expired and revoked traffic costs zero DO
// quota — the object is only ever woken for a caller who has already been fully authorized.
dataApi.get('/_sync/socket', async (c) => {
  if (!isUpgrade(c)) return c.text('expected websocket', 426)
  const room = c.env.SITE_ROOM
  // Optional binding (like AI): a deploy that never enabled realtime keeps the whole HTTP data
  // plane — including the catch-up feed — working, and simply cannot be subscribed to.
  if (!room) return c.json({ error: 'realtime unavailable' }, 503)

  const claims = c.get('claims')
  // THE ROOM IS NAMED BY THE TOKEN'S siteId, never by anything in the URL. The token carries no
  // space/slug, so a slug in the path could only be an unverified caller-supplied key — a viewer
  // holding a token for site X would join site Y's room and receive its events (a full IDOR).
  // notify.ts keys the write side the same way, and the DO hard-compares its own name against the
  // claims it re-verifies, so all three agree or nothing is delivered.
  const stub = room.get(room.idFromName(claims.siteId))
  // HARD-CODED, exactly like the comments route's `channel=comments`, and for the same reason in
  // reverse: the channel tag is the ONLY wall between the two streams — `caps: []` is not one, since
  // `readsEveryCreator` holds for any `shared-*` collection regardless of caps. THIS is the token
  // the browser itself holds, so honouring a caller-supplied `?channel` would let any page with a
  // data token dial `chan:comments` and receive every thread body, author name and typing ping on
  // the site. No caller has ever sent the param: the shipped SDK dials bare.
  const res = await stub.fetch(
    new Request('https://site-room/subscribe?channel=db', {
      // The token rides one dedicated header — never a URL, never the DO's own name. The worker's
      // check above is a cheap quota guard, NOT the authority: the DO verifies the token again.
      headers: { Upgrade: 'websocket', [TOKEN_HEADER]: c.get('token') },
    }),
  )
  return reissueUpgrade(c, res)
})

// Create a document (server-generated id).
dataApi.post('/:collection', async (c) => {
  const claims = c.get('claims')
  const collection = c.req.param('collection')
  if (!COLLECTION_RE.test(collection)) return c.json({ error: 'invalid collection' }, 400)
  const parsed = await readJsonBody(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const db = getDb(c)
  if (await atSiteDocQuota(db, claims.siteId)) return c.json({ error: 'site document quota exceeded' }, 429)

  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  // siteId + createdBy come from the verified TOKEN, not the body — a body carrying its own
  // `siteId`/`createdBy` keys just lands inside the opaque `json` blob and changes nothing.
  // The change_log row rides the SAME batch (one D1 transaction), so a replayable event exists
  // for every row that exists — see realtime/change-log.
  const [logged] = await db.batch([
    logChangeStmt(db, {
      siteId: claims.siteId,
      collection,
      docId,
      createdBy: claims.viewerId,
      type: 'create',
      at: now,
    }),
    db.insert(documents).values({
      siteId: claims.siteId,
      collection,
      docId,
      json: parsed.value,
      createdBy: claims.viewerId,
      createdAt: now,
      updatedAt: now,
    }),
  ])
  await notifyChange(c, logged[0])
  return c.json({ id: docId, data: parsed.value, createdAt: now, updatedAt: now }, 201)
})

// Read one document. Default: the caller's own rows; site-wide when the collection is
// `shared-*` or the token carries `read_all` (owner/superadmin).
dataApi.get('/:collection/:docId', async (c) => {
  const claims = c.get('claims')
  const collection = c.req.param('collection')
  const docId = c.req.param('docId')
  if (!COLLECTION_RE.test(collection) || !DOCID_RE.test(docId)) return c.json({ error: 'not found' }, 404)
  const row = (
    await getDb(c)
      .select()
      .from(documents)
      .where(and(...docWhere(claims, collection, docId), ...readCreatorWhere(claims, collection)))
      .limit(1)
  )[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(toDoc(row))
})

// List documents in a collection, newest first. Default: ONLY the caller's own rows; the whole
// site's rows for `shared-*` collections (any viewer) or a `read_all` token (owner/superadmin).
dataApi.get('/:collection', async (c) => {
  const claims = c.get('claims')
  const collection = c.req.param('collection')
  if (!COLLECTION_RE.test(collection)) return c.json({ error: 'invalid collection' }, 400)
  const rows = await getDb(c)
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.siteId, claims.siteId),
        eq(documents.collection, collection),
        ...readCreatorWhere(claims, collection),
      ),
    )
    .orderBy(desc(documents.createdAt))
    .limit(clampLimit(c.req.query('limit')))
  return c.json({ items: rows.map(toDoc) })
})

// Upsert a document at a caller-chosen id. A doc owned by another viewer is invisible
// (404, not 403 — existence isn't disclosed) and cannot be overwritten.
dataApi.put('/:collection/:docId', async (c) => {
  const claims = c.get('claims')
  const collection = c.req.param('collection')
  const docId = c.req.param('docId')
  if (!COLLECTION_RE.test(collection) || !DOCID_RE.test(docId)) return c.json({ error: 'invalid id' }, 400)
  const parsed = await readJsonBody(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const db = getDb(c)
  const now = new Date().toISOString()
  const updateExisting = async (): Promise<Response | null> => {
    const existing = (
      await db
        .select({ createdBy: documents.createdBy, createdAt: documents.createdAt })
        .from(documents)
        .where(
          and(eq(documents.siteId, claims.siteId), eq(documents.collection, collection), eq(documents.docId, docId)),
        )
        .limit(1)
    )[0]
    if (!existing) return null
    if (existing.createdBy !== claims.viewerId) return c.json({ error: 'not found' }, 404)
    const [logged] = await db.batch([
      // createdBy is the row's own creator (== viewerId here, since the guard above 404s any
      // foreign row) — never the writer, so the same field means the same thing on every path.
      logChangeStmt(db, {
        siteId: claims.siteId,
        collection,
        docId,
        createdBy: existing.createdBy,
        type: 'update',
        at: now,
      }),
      db.update(documents).set({ json: parsed.value, updatedAt: now }).where(scoped(claims, collection, docId)),
    ])
    await notifyChange(c, logged[0])
    return c.json({ id: docId, data: parsed.value, createdAt: existing.createdAt, updatedAt: now })
  }

  const updated = await updateExisting()
  if (updated) return updated
  // A fresh id adds a NEW row, so it is subject to the per-site quota (the update path above never
  // grows the table). Checked here — after the update fast-path — so overwrites are never blocked.
  if (await atSiteDocQuota(db, claims.siteId)) return c.json({ error: 'site document quota exceeded' }, 429)
  // Fresh id: insert race-safely. onConflictDoNothing + returning() means a concurrent first-PUT
  // can never 500 on the unique index — an empty return says the row appeared meanwhile, so take
  // the update path after all (which also yields the correct 404 if the winner was another viewer).
  // The log statement runs first and carries the SAME "id still free" condition the unique index
  // enforces, so the race that makes the insert a no-op also makes the log a no-op — a lost race
  // logs (and pushes) nothing, and the retry below records the 'update' it actually became.
  const [logged, inserted] = await db.batch([
    logCreateIfAbsentStmt(db, {
      siteId: claims.siteId,
      collection,
      docId,
      createdBy: claims.viewerId,
      type: 'create',
      at: now,
    }),
    db
      .insert(documents)
      .values({
        siteId: claims.siteId,
        collection,
        docId,
        json: parsed.value,
        createdBy: claims.viewerId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: documents.id }),
  ])
  if (inserted.length === 0) return (await updateExisting()) ?? c.json({ error: 'not found' }, 404)
  await notifyChange(c, logged[0])
  return c.json({ id: docId, data: parsed.value, createdAt: now, updatedAt: now }, 201)
})

// Delete a document. Creator-scoped by default; a `read_all` token (owner/superadmin — always
// paired with `write` at mint) deletes ANY document in the site: that is the moderation story
// for viewer-submitted content (spam in a feedback form, a hostile poll entry).
dataApi.delete('/:collection/:docId', async (c) => {
  const claims = c.get('claims')
  const collection = c.req.param('collection')
  const docId = c.req.param('docId')
  if (!COLLECTION_RE.test(collection) || !DOCID_RE.test(docId)) return c.json({ error: 'not found' }, 404)
  const where = hasCap(claims, 'read_all')
    ? and(...docWhere(claims, collection, docId))
    : scoped(claims, collection, docId)
  // The log SELECTs the doomed row through the very same predicate, one statement before the
  // delete in the same batch: that is the only moment the DOCUMENT's creator still exists, and a
  // predicate matching nothing logs nothing (so a no-op delete still 204s but pushes no phantom).
  const db = getDb(c)
  const [logged] = await db.batch([
    logDeletedStmt(db, claims.siteId, new Date().toISOString(), where),
    db.delete(documents).where(where),
  ])
  await notifyChange(c, logged[0])
  return c.body(null, 204)
})

// Tenant wall for a single doc: token siteId + collection + docId. NEVER used without either
// the creator wall or an owner-tier cap on top.
function docWhere(claims: DataClaims, collection: string, docId: string) {
  return [eq(documents.siteId, claims.siteId), eq(documents.collection, collection), eq(documents.docId, docId)]
}

// The creator wall for READS, expressed in SQL. The POLICY itself is not restated here — it is
// DERIVED from lib/data-visibility, the single source of truth shared with every other read path
// (a realtime fan-out filter asks canViewerRead for the same answer this WHERE clause encodes).
// Returned as a spreadable list so callers AND it in.
function readCreatorWhere(claims: DataClaims, collection: string) {
  return readsEveryCreator(claims, collection) ? [] : [eq(documents.createdBy, claims.viewerId)]
}

// Every single-doc WRITE query is scoped by (token siteId + collection + docId + token viewer)
// so a docId from another site or another viewer can never be touched (tenant + creator
// isolation) — shared-* read visibility never widens write reach.
function scoped(claims: DataClaims, collection: string, docId: string) {
  return and(...docWhere(claims, collection, docId), eq(documents.createdBy, claims.viewerId))
}

// Cheap per-site row COUNT (siteId is the leftmost column of documents_site_collection_creator,
// so this is a covering index scan) gating every INSERT — an authorized viewer can't create
// unbounded documents. A SOFT cap: the COUNT→insert window is racy under concurrency, acceptable
// for a modest DoS guard. Reads and in-place updates are unaffected (updates never add a row).
async function atSiteDocQuota(db: DrizzleD1Database, siteId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(documents).where(eq(documents.siteId, siteId))
  return (row?.n ?? 0) >= MAX_DOCS_PER_SITE
}

const enc = new TextEncoder()

type Parsed = { ok: true; value: unknown } | { ok: false; error: string; status: 400 | 413 }
async function readJsonBody(c: DataCtx): Promise<Parsed> {
  // Cheap reject before buffering when the client declares a size; the byte check after reading
  // is authoritative (string .length counts UTF-16 units, not bytes — multibyte payloads would
  // otherwise sneak ~4x past the cap). A missing/unparseable/understated content-length yields a
  // non-finite (or too-small) value here, so it FALLS THROUGH to the post-read byte cap below —
  // that check, not this precheck, is the real guard. Until the read completes we lean on the
  // Workers runtime's platform request-size limit as the backstop against an unbounded chunked
  // (no content-length) body; a per-chunk stream cap would be over-engineering at this severity.
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    return { ok: false, error: 'document too large', status: 413 }
  }
  const raw = await c.req.text()
  if (enc.encode(raw).byteLength > MAX_JSON_BYTES) return { ok: false, error: 'document too large', status: 413 }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'invalid json', status: 400 }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'document must be a json object', status: 400 }
  }
  return { ok: true, value }
}

function clampLimit(q: string | undefined): number {
  const n = Number(q)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

// createdBy is exposed (an opaque user id): shared collections and owner reads need to group
// and attribute rows — resolving ids to names stays a follow-up.
function toDoc(row: DocumentRow) {
  return { id: row.docId, data: row.json, createdBy: row.createdBy, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

// --- Session-authenticated mint (trusted app origin) ---

// The single source of truth for capability bundles. Every authorized viewer may READ (their
// own rows + shared-* collections) and CREATE (attributed submissions — this is what makes
// forms/polls possible). Only the site owner or a superadmin gets WRITE (update/delete) and
// READ_ALL (see + moderate every row). "Can view" still never implies "can modify": a viewer
// cannot touch any existing document, not even their own. Pure + exported so the invariant is
// unit-tested directly, independent of the request/session plumbing.
//
// SECURITY — editor-share confused-deputy (ACCEPTED residual risk, S9): caps key ONLY on ownerId,
// so a content EDITOR of this site is indistinguishable from any other non-owner and gets read+create
// only — they never mint write/read_all. This is deliberate: an editor can plant JS in the site, and
// when the OWNER opens it that script would run with the owner's caps. Do NOT thread the editor's
// share-role in here to "grant" them write — that would hand every editor read_all/delete over the
// owner's glance.db docs. Signed off as accepted (editor = semi-trusted, git-collaborator model);
// if that changes, gate on sites.lastReplacedBy (downgrade to viewer until the owner re-deploys).
// `dataCaps.editor.pin` in data.test.ts locks this.
export function dataCapsFor(user: Pick<SessionUser, 'id' | 'role'>, site: Pick<Site, 'ownerId'>): DataCapability[] {
  return user.role === 'superadmin' || site.ownerId === user.id
    ? ['read', 'create', 'write', 'read_all']
    : ['read', 'create']
}

// Intersect a caller's own caps ceiling (`base`, from dataCapsFor) against an API key's data-plane
// ceiling. `ceiling: null` means the caller isn't key-authenticated — base passes through
// UNCHANGED, byte-for-byte, so session/CLI callers are untouched. Otherwise the result is the
// overlap: it can only ever narrow `base`, never add a cap `base` didn't already have — order is
// `base`'s, so existing assertions on the caps array keep passing.
export function intersectCaps(base: DataCapability[], ceiling: DataCapability[] | null): DataCapability[] {
  return ceiling ? base.filter((cap) => ceiling.includes(cap)) : base
}

export const dataToken = new Hono<AppEnv>()
dataToken.use('*', requireAuth)

// Exchange a site (by space/site slug) for a short-lived data token. WRITE is granted ONLY to
// the site owner (or superadmin); any other authorized viewer — including any authenticated
// user on a `team` site — receives READ-only. This is where "can view" is prevented from
// implying "can write": the untrusted content page can only ever act with the caps minted here.
//
// A key-authenticated caller intersects with its OWN grant: the allowlist gates WHICH site it may
// mint for at all (403 outside it, or outside its owned sites for an 'all-owned' scope), and
// `data.caps` ceilings WHAT the minted token may carry — never widening the caller's own access,
// never granted by the key alone if the caller's own access is narrower (see intersectCaps).
dataToken.post('/:space/:site', async (c) => {
  if (!c.env.DATA_TOKEN_SECRET) return c.json({ error: 'not found' }, 404)
  const db = c.get('db')
  const user = c.get('user')
  const { space, site: siteSlug } = c.req.param()
  const { facts } = await fetchAccessFacts(db, space, siteSlug, user.id)
  const { site, access } = siteAccessFromFacts(facts, user)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  const credential = c.get('credential')
  let ceiling: DataCapability[] | null = null
  if (credential.kind === 'key') {
    if (!credential.grants.data) return c.json({ error: 'forbidden' }, 403)
    const { scope, caps } = credential.grants.data
    const allowed = scope.kind === 'all-owned' ? site.ownerId === user.id : scope.siteIds.includes(site.id)
    if (!allowed) return c.json({ error: 'forbidden' }, 403)
    ceiling = caps
  }

  const caps = intersectCaps(dataCapsFor(user, site), ceiling)
  if (caps.length === 0) return c.json({ error: 'forbidden' }, 403)
  const token = await signDataToken(
    c.env.DATA_TOKEN_SECRET,
    { siteId: site.id, viewerId: user.id, caps },
    DATA_TOKEN_TTL_SEC,
  )
  return c.json({ token, caps, expiresIn: DATA_TOKEN_TTL_SEC })
})
