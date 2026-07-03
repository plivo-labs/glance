import { and, eq } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { type Context, Hono } from 'hono'
import { isSpaceMember, resolveIsShared, toSessionUser } from '../db/repo'
import { type DocumentRow, type Site, documents, sites, spaces, users } from '../db/schema'
import { checkAccess } from '../lib/access'
import { type DataCapability, type DataClaims, hasCap, signDataToken, verifyDataToken } from '../lib/data-token'
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

// `injectedDb` lets tests wrap this sub-app and supply the in-memory harness DB (mirrors the
// content worker's getDb seam); prod leaves it unset and a per-request D1 client is built.
type DataEnv = { Bindings: Bindings; Variables: { injectedDb?: DrizzleD1Database; ddb: DrizzleD1Database; claims: DataClaims } }
type DataCtx = Context<DataEnv>

function getDb(c: DataCtx): DrizzleD1Database {
  return c.get('injectedDb') ?? drizzle(c.env.GLANCE_DB)
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

// Verify the bearer data token, then LIVE re-authorize against current DB state: recover the
// site + viewer and re-run the same checkAccess the content worker uses, so a revoked share,
// tightened visibility, archived site, or deleted user blocks data access immediately — the
// token is never trusted as a standalone snapshot.
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

  const [userRow, isMember, isShared] = await Promise.all([
    db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, claims.viewerId))
      .limit(1)
      .then((r) => r[0]),
    isSpaceMember(db, site.spaceId, claims.viewerId),
    resolveIsShared(db, site.id, claims.viewerId),
  ])
  if (!userRow) return c.json({ error: 'forbidden' }, 403)
  const access = checkAccess(site, toSessionUser(userRow), isMember, isShared)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  c.set('ddb', db)
  c.set('claims', claims)
  await next()
})

// Create a document (server-generated id). Requires the write capability.
dataApi.post('/:collection', async (c) => {
  const claims = c.get('claims')
  if (!hasCap(claims, 'write')) return c.json({ error: 'forbidden' }, 403)
  const collection = c.req.param('collection')
  if (!COLLECTION_RE.test(collection)) return c.json({ error: 'invalid collection' }, 400)
  const parsed = await readJsonBody(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  // siteId + createdBy come from the verified TOKEN, not the body — a body carrying its own
  // `siteId`/`createdBy` keys just lands inside the opaque `json` blob and changes nothing.
  await c.get('ddb').insert(documents).values({
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

// Read one document. Requires read; scoped to the token's site + the caller's own rows.
dataApi.get('/:collection/:docId', async (c) => {
  const claims = c.get('claims')
  if (!hasCap(claims, 'read')) return c.json({ error: 'forbidden' }, 403)
  const collection = c.req.param('collection')
  const docId = c.req.param('docId')
  if (!COLLECTION_RE.test(collection) || !DOCID_RE.test(docId)) return c.json({ error: 'not found' }, 404)
  const row = (
    await c
      .get('ddb')
      .select()
      .from(documents)
      .where(scoped(claims, collection, docId))
      .limit(1)
  )[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(toDoc(row))
})

// List documents in a collection. Requires read; returns ONLY the caller's own rows in this
// site+collection (default per-creator read policy — "public within site" is a future opt-in).
dataApi.get('/:collection', async (c) => {
  const claims = c.get('claims')
  if (!hasCap(claims, 'read')) return c.json({ error: 'forbidden' }, 403)
  const collection = c.req.param('collection')
  if (!COLLECTION_RE.test(collection)) return c.json({ error: 'invalid collection' }, 400)
  const rows = await c
    .get('ddb')
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.siteId, claims.siteId),
        eq(documents.collection, collection),
        eq(documents.createdBy, claims.viewerId),
      ),
    )
    .limit(clampLimit(c.req.query('limit')))
  return c.json({ items: rows.map(toDoc) })
})

// Upsert a document at a caller-chosen id. Requires write; a doc owned by another viewer is
// invisible (404, not 403 — existence isn't disclosed) and cannot be overwritten.
dataApi.put('/:collection/:docId', async (c) => {
  const claims = c.get('claims')
  if (!hasCap(claims, 'write')) return c.json({ error: 'forbidden' }, 403)
  const collection = c.req.param('collection')
  const docId = c.req.param('docId')
  if (!COLLECTION_RE.test(collection) || !DOCID_RE.test(docId)) return c.json({ error: 'invalid id' }, 400)
  const parsed = await readJsonBody(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const db = c.get('ddb')
  const existing = (
    await db
      .select({ createdBy: documents.createdBy, createdAt: documents.createdAt })
      .from(documents)
      .where(and(eq(documents.siteId, claims.siteId), eq(documents.collection, collection), eq(documents.docId, docId)))
      .limit(1)
  )[0]
  const now = new Date().toISOString()
  if (existing) {
    if (existing.createdBy !== claims.viewerId) return c.json({ error: 'not found' }, 404)
    await db
      .update(documents)
      .set({ json: parsed.value, updatedAt: now })
      .where(scoped(claims, collection, docId))
    return c.json({ id: docId, data: parsed.value, createdAt: existing.createdAt, updatedAt: now })
  }
  await db.insert(documents).values({
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

// Delete a document. Requires write; scoped to the token's site + the caller's own rows.
dataApi.delete('/:collection/:docId', async (c) => {
  const claims = c.get('claims')
  if (!hasCap(claims, 'write')) return c.json({ error: 'forbidden' }, 403)
  const collection = c.req.param('collection')
  const docId = c.req.param('docId')
  if (!COLLECTION_RE.test(collection) || !DOCID_RE.test(docId)) return c.json({ error: 'not found' }, 404)
  await c.get('ddb').delete(documents).where(scoped(claims, collection, docId))
  return c.body(null, 204)
})

// Every single-doc query is scoped by (token siteId + collection + docId + token viewer) so a
// docId from another site or another viewer can never be reached (tenant + creator isolation).
function scoped(claims: DataClaims, collection: string, docId: string) {
  return and(
    eq(documents.siteId, claims.siteId),
    eq(documents.collection, collection),
    eq(documents.docId, docId),
    eq(documents.createdBy, claims.viewerId),
  )
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string; status: 400 | 413 }
async function readJsonBody(c: DataCtx): Promise<Parsed> {
  const raw = await c.req.text()
  if (raw.length > MAX_JSON_BYTES) return { ok: false, error: 'document too large', status: 413 }
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

function toDoc(row: DocumentRow) {
  return { id: row.docId, data: row.json, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

// --- Session-authenticated mint (trusted app origin) ---

// The single source of truth for "who gets write". WRITE is the site owner (or a superadmin)
// ONLY; everyone else who can access the site gets READ. Pure + exported so the write≠view
// invariant is unit-tested directly, independent of the request/session plumbing.
export function dataCapsFor(user: Pick<SessionUser, 'id' | 'role'>, site: Pick<Site, 'ownerId'>): DataCapability[] {
  return user.role === 'superadmin' || site.ownerId === user.id ? ['read', 'write'] : ['read']
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
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(and(eq(spaces.slug, space), eq(sites.slug, siteSlug)))
      .limit(1)
  )[0]
  if (!site) return c.json({ error: 'not found' }, 404)

  const [isMember, isShared] = await Promise.all([
    isSpaceMember(db, site.spaceId, user.id),
    resolveIsShared(db, site.id, user.id),
  ])
  const access = checkAccess(site, user, isMember, isShared)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  const caps = dataCapsFor(user, site)
  const token = await signDataToken(c.env.DATA_TOKEN_SECRET, { siteId: site.id, viewerId: user.id, caps }, DATA_TOKEN_TTL_SEC)
  return c.json({ token, caps, expiresIn: DATA_TOKEN_TTL_SEC })
})
