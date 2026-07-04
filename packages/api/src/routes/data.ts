import { and, desc, eq } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { type Context, Hono } from 'hono'
import { type DocumentRow, type Site, documents, sites } from '../db/schema'
import { type DataCapability, type DataClaims, hasCap, signDataToken, verifyDataToken } from '../lib/data-token'
import { authorizeViewerById, resolveSiteForAccess } from '../lib/site-access'
import { requireAuth } from '../middleware/auth'
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
const DATA_TOKEN_TTL_SEC = 300
// Read-policy opt-in by naming convention: documents in a `shared-*` collection are readable by
// EVERY authorized viewer of the site (polls, boards, tallies). Writes are unaffected — put and
// delete stay creator-scoped, so a shared collection is many-writers-of-their-own-rows, never a
// free-for-all.
const SHARED_PREFIX = 'shared-'

// `db` is optional: production runs no middleware that sets it, so getDb() falls back to a
// per-request client from the D1 binding; tests inject the in-memory harness db via c.set('db')
// — the same seam the content worker uses.
type DataEnv = { Bindings: Bindings; Variables: { db?: DrizzleD1Database; claims: DataClaims } }
type DataCtx = Context<DataEnv>

function getDb(c: DataCtx): DrizzleD1Database {
  return c.get('db') ?? drizzle(c.env.GLANCE_DB)
}

export const dataApi = new Hono<DataEnv>()

// Exact-origin, credential-less CORS. ACAO is pinned to CONTENT_URL (never reflected back from
// the request Origin) and NO Access-Control-Allow-Credentials is emitted, so a browser never
// attaches the app session cookie to these routes — the bearer data token is the only authority.
// Inert (404) when DATA_TOKEN_SECRET is unset, so the feature is opt-in per deploy.
dataApi.use('*', async (c, next) => {
  if (!c.env.DATA_TOKEN_SECRET) return c.text('Not found', 404)
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
  const header = c.req.header('Authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
  const claims = await verifyDataToken(c.env.DATA_TOKEN_SECRET as string, token)
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
  await next()
})

// Method → required capability, enforced structurally for every current AND future route on
// this surface — a new endpoint cannot ship without a capability check. POST maps to `create`
// (every viewer may submit attributed documents); PUT/DELETE stay behind `write` (owner-only).
const METHOD_CAP: Record<string, DataCapability> = { GET: 'read', HEAD: 'read', POST: 'create', PUT: 'write', DELETE: 'write' }
dataApi.use('*', async (c, next) => {
  const cap = METHOD_CAP[c.req.method]
  if (!cap || !hasCap(c.get('claims'), cap)) return c.json({ error: 'forbidden' }, 403)
  await next()
})

// Create a document (server-generated id).
dataApi.post('/:collection', async (c) => {
  const claims = c.get('claims')
  const collection = c.req.param('collection')
  if (!COLLECTION_RE.test(collection)) return c.json({ error: 'invalid collection' }, 400)
  const parsed = await readJsonBody(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  // siteId + createdBy come from the verified TOKEN, not the body — a body carrying its own
  // `siteId`/`createdBy` keys just lands inside the opaque `json` blob and changes nothing.
  await getDb(c).insert(documents).values({
    siteId: claims.siteId,
    collection,
    docId,
    json: parsed.value,
    createdBy: claims.viewerId,
    createdAt: now,
    updatedAt: now,
  })
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
        .where(and(eq(documents.siteId, claims.siteId), eq(documents.collection, collection), eq(documents.docId, docId)))
        .limit(1)
    )[0]
    if (!existing) return null
    if (existing.createdBy !== claims.viewerId) return c.json({ error: 'not found' }, 404)
    await db
      .update(documents)
      .set({ json: parsed.value, updatedAt: now })
      .where(scoped(claims, collection, docId))
    return c.json({ id: docId, data: parsed.value, createdAt: existing.createdAt, updatedAt: now })
  }

  const updated = await updateExisting()
  if (updated) return updated
  // Fresh id: insert race-safely. onConflictDoNothing + returning() means a concurrent first-PUT
  // can never 500 on the unique index — an empty return says the row appeared meanwhile, so take
  // the update path after all (which also yields the correct 404 if the winner was another viewer).
  const inserted = await db
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
    .returning({ id: documents.id })
  if (inserted.length === 0) return (await updateExisting()) ?? c.json({ error: 'not found' }, 404)
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
  await getDb(c).delete(documents).where(where)
  return c.body(null, 204)
})

// Tenant wall for a single doc: token siteId + collection + docId. NEVER used without either
// the creator wall or an owner-tier cap on top.
function docWhere(claims: DataClaims, collection: string, docId: string) {
  return [eq(documents.siteId, claims.siteId), eq(documents.collection, collection), eq(documents.docId, docId)]
}

// The creator wall for READS, dropped only for `shared-*` collections (opt-in by name, visible
// to every viewer) or a `read_all` token. Returned as a spreadable list so callers AND it in.
function readCreatorWhere(claims: DataClaims, collection: string) {
  return collection.startsWith(SHARED_PREFIX) || hasCap(claims, 'read_all')
    ? []
    : [eq(documents.createdBy, claims.viewerId)]
}

// Every single-doc WRITE query is scoped by (token siteId + collection + docId + token viewer)
// so a docId from another site or another viewer can never be touched (tenant + creator
// isolation) — shared-* read visibility never widens write reach.
function scoped(claims: DataClaims, collection: string, docId: string) {
  return and(
    eq(documents.siteId, claims.siteId),
    eq(documents.collection, collection),
    eq(documents.docId, docId),
    eq(documents.createdBy, claims.viewerId),
  )
}

const enc = new TextEncoder()

type Parsed = { ok: true; value: unknown } | { ok: false; error: string; status: 400 | 413 }
async function readJsonBody(c: DataCtx): Promise<Parsed> {
  // Cheap reject before buffering when the client declares a size; the byte check after reading
  // is authoritative (string .length counts UTF-16 units, not bytes — multibyte payloads would
  // otherwise sneak ~4x past the cap).
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
export function dataCapsFor(user: Pick<SessionUser, 'id' | 'role'>, site: Pick<Site, 'ownerId'>): DataCapability[] {
  return user.role === 'superadmin' || site.ownerId === user.id
    ? ['read', 'create', 'write', 'read_all']
    : ['read', 'create']
}

export const dataToken = new Hono<AppEnv>()
dataToken.use('*', requireAuth)

// Exchange a site (by space/site slug) for a short-lived data token. WRITE is granted ONLY to
// the site owner (or superadmin); any other authorized viewer — including any authenticated
// user on a `team` site — receives READ-only. This is where "can view" is prevented from
// implying "can write": the untrusted content page can only ever act with the caps minted here.
dataToken.post('/:space/:site', async (c) => {
  if (!c.env.DATA_TOKEN_SECRET) return c.json({ error: 'not found' }, 404)
  const db = c.get('db')
  const user = c.get('user')
  const { space, site: siteSlug } = c.req.param()
  const { site, access } = await resolveSiteForAccess(db, space, siteSlug, user)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  const caps = dataCapsFor(user, site)
  const token = await signDataToken(c.env.DATA_TOKEN_SECRET, { siteId: site.id, viewerId: user.id, caps }, DATA_TOKEN_TTL_SEC)
  return c.json({ token, caps, expiresIn: DATA_TOKEN_TTL_SEC })
})
