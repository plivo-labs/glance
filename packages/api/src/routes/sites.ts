import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  isSpaceMember,
  listSiteShares,
  memberSpaceIds,
  replaceSiteShares,
  resolveIsShared,
  sharedSiteIds,
} from '../db/repo'
import type { Visibility } from '../db/schema'
import { sites as sitesTable, spaces, users } from '../db/schema'
import { checkAccess } from '../lib/access'
import { readSession } from '../lib/session'
import { resolveSite } from '../lib/site-access'
import { isValidSlug } from '../lib/slug'
import { deleteSiteObjects } from '../lib/storage'
import { signToken } from '../lib/token'
import { isVisibility, normalizeVisibility } from '../lib/visibility'
import { requireAuth } from '../middleware/auth'
import type { AppEnv, SessionUser } from '../types'

// Phase 4: site CRUD + viewer metadata. Mounted at /api/sites.

// Gated-content link lifetime. The token rides in the iframe URL path and is inherited by
// relative sub-resources, so it must outlast a real viewing session — 5min broke long views
// and lazily-loaded assets. Re-minted on every viewer load.
const CONTENT_TOKEN_TTL = 60 * 60 // 1h

export const sites = new Hono<AppEnv>()

// `resolveSite` now lives in lib/site-access (shared with the comments routes); see import.

// Over-fetch a little past the result cap so the in-memory checkAccess pass can drop a few
// non-openable candidates and still fill the cap.
const SEARCH_SCAN_CAP = 200

export type SearchRow = {
  id: string
  spaceId: string
  spaceSlug: string
  siteSlug: string
  title: string | null
  visibility: Visibility
  status: 'active' | 'archived'
  ownerId: string
  createdAt: string
}

/**
 * cmdk site search. ONE bounded candidate query over *active* sites the caller might open
 * (owner / member-space / team / explicitly-shared; superadmin ⇒ all active), then a
 * final in-memory checkAccess pass — the single source of truth — using precomputed
 * membership/share sets so it stays O(rows), not N+1. "Openable" semantics: the result is
 * exactly what checkAccess admits. q matches site title/slug or its space slug/name.
 */
export async function searchSites(
  db: AppEnv['Variables']['db'],
  user: SessionUser,
  q: string,
  limit = 20,
): Promise<SearchRow[]> {
  const term = `%${q.trim().toLowerCase()}%`
  const qMatch = sql`(lower(${sitesTable.title}) like ${term} or lower(${sitesTable.slug}) like ${term} or lower(${spaces.slug}) like ${term} or lower(${spaces.name}) like ${term})`

  const isSuper = user.role === 'superadmin'
  const memberSpaces = isSuper ? new Set<string>() : await memberSpaceIds(db, user.id)
  const shared = isSuper ? new Set<string>() : await sharedSiteIds(db, user.id)

  let where = and(eq(sitesTable.status, 'active'), qMatch)
  if (!isSuper) {
    const reach = [eq(sitesTable.ownerId, user.id), eq(sitesTable.visibility, 'team')]
    if (memberSpaces.size) reach.push(inArray(sitesTable.spaceId, [...memberSpaces]))
    if (shared.size) reach.push(inArray(sitesTable.id, [...shared]))
    where = and(where, or(...reach))
  }

  const rows = await db
    .select({
      id: sitesTable.id,
      spaceId: sitesTable.spaceId,
      spaceSlug: spaces.slug,
      siteSlug: sitesTable.slug,
      title: sitesTable.title,
      visibility: sitesTable.visibility,
      status: sitesTable.status,
      ownerId: sitesTable.ownerId,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(where)
    .orderBy(desc(sitesTable.createdAt))
    .limit(SEARCH_SCAN_CAP)

  return rows
    .filter((r) => checkAccess(r, user, memberSpaces.has(r.spaceId), shared.has(r.id)).ok)
    .slice(0, limit)
}

// POST /api/sites — create an empty site in a space the caller belongs to.
sites.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)

  const { spaceSlug, siteSlug, title, visibility } = body as {
    spaceSlug?: unknown
    siteSlug?: unknown
    title?: unknown
    visibility?: unknown
  }
  if (typeof spaceSlug !== 'string' || typeof siteSlug !== 'string') {
    return c.json({ error: 'spaceSlug and siteSlug are required' }, 400)
  }
  if (!isValidSlug(siteSlug)) return c.json({ error: 'invalid siteSlug' }, 400)
  const vis = normalizeVisibility(visibility)
  if (visibility !== undefined && !isVisibility(vis)) {
    return c.json({ error: 'invalid visibility' }, 400)
  }
  if (title !== undefined && title !== null && typeof title !== 'string') {
    return c.json({ error: 'invalid title' }, 400)
  }

  const space = (
    await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.slug, spaceSlug)).limit(1)
  )[0]
  if (!space) return c.json({ error: 'space not found' }, 404)
  if (!(await isSpaceMember(db, space.id, user.id))) return c.json({ error: 'forbidden' }, 403)

  const existing = (
    await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(and(eq(sitesTable.spaceId, space.id), eq(sitesTable.slug, siteSlug)))
      .limit(1)
  )[0]
  if (existing) return c.json({ error: 'site already exists' }, 409)

  const id = crypto.randomUUID()
  await db.insert(sitesTable).values({
    id,
    spaceId: space.id,
    slug: siteSlug,
    title: typeof title === 'string' ? title : null,
    visibility: isVisibility(vis) ? vis : 'team',
    ownerId: user.id,
  })

  return c.json({ id, spaceSlug, siteSlug, url: `${c.env.APP_URL}/${spaceSlug}/${siteSlug}` }, 201)
})

// GET /api/sites/mine — sites owned by the caller, newest first.
sites.get('/mine', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const rows = await db
    .select({
      id: sitesTable.id,
      spaceSlug: spaces.slug,
      slug: sitesTable.slug,
      title: sitesTable.title,
      visibility: sitesTable.visibility,
      status: sitesTable.status,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(eq(sitesTable.ownerId, user.id))
    .orderBy(desc(sitesTable.createdAt))

  return c.json(
    rows.map((r) => ({
      id: r.id,
      spaceSlug: r.spaceSlug,
      siteSlug: r.slug,
      title: r.title,
      visibility: r.visibility,
      status: r.status,
      url: `${c.env.APP_URL}/${r.spaceSlug}/${r.slug}`,
      createdAt: r.createdAt,
    })),
  )
})

// GET /api/sites/shared — sites shared with the caller (directly or via a group), newest first.
sites.get('/shared', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const ids = [...(await sharedSiteIds(db, user.id))]
  if (ids.length === 0) return c.json([])
  const rows = await db
    .select({
      id: sitesTable.id,
      spaceSlug: spaces.slug,
      slug: sitesTable.slug,
      title: sitesTable.title,
      visibility: sitesTable.visibility,
      status: sitesTable.status,
      ownerId: sitesTable.ownerId,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(inArray(sitesTable.id, ids))
    .orderBy(desc(sitesTable.createdAt))
  return c.json(
    rows
      .filter((r) => r.status === 'active' && r.ownerId !== user.id)
      .map((r) => ({
        id: r.id,
        spaceSlug: r.spaceSlug,
        siteSlug: r.slug,
        title: r.title,
        visibility: r.visibility,
        status: r.status,
        url: `${c.env.APP_URL}/${r.spaceSlug}/${r.slug}`,
        createdAt: r.createdAt,
      })),
  )
})

// GET /api/sites/team — team-wide upload feed: every team site across all spaces,
// newest first, with who uploaded it. Visible to any signed-in member (the team tier is
// already visible team-wide). Capped — this is an at-a-glance activity feed, not a full log.
sites.get('/team', requireAuth, async (c) => {
  const db = c.get('db')
  const rows = await db
    .select({
      id: sitesTable.id,
      spaceSlug: spaces.slug,
      slug: sitesTable.slug,
      title: sitesTable.title,
      visibility: sitesTable.visibility,
      status: sitesTable.status,
      createdAt: sitesTable.createdAt,
      uploaderName: users.name,
      uploaderEmail: users.email,
    })
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .innerJoin(users, eq(sitesTable.ownerId, users.id))
    .where(and(eq(sitesTable.status, 'active'), eq(sitesTable.visibility, 'team')))
    .orderBy(desc(sitesTable.createdAt))
    .limit(50)
  return c.json(
    rows.map((r) => ({
      id: r.id,
      spaceSlug: r.spaceSlug,
      siteSlug: r.slug,
      title: r.title,
      visibility: r.visibility,
      status: r.status,
      url: `${c.env.APP_URL}/${r.spaceSlug}/${r.slug}`,
      createdAt: r.createdAt,
      uploaderName: r.uploaderName,
      uploaderEmail: r.uploaderEmail,
    })),
  )
})

// GET /api/sites/search?q= — cmdk search across every site the caller can open (all tiers,
// not just the 6 most-recent owned). Empty q → []. 1-segment path, no catch-all collision.
sites.get('/search', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json([])
  const rows = await searchSites(db, user, q)
  return c.json(
    rows.map((r) => ({
      id: r.id,
      spaceSlug: r.spaceSlug,
      siteSlug: r.siteSlug,
      title: r.title,
      visibility: r.visibility,
      status: r.status,
      isOwner: r.ownerId === user.id,
      url: `${c.env.APP_URL}/${r.spaceSlug}/${r.siteSlug}`,
      createdAt: r.createdAt,
    })),
  )
})

// GET /api/sites/:spaceSlug/:siteSlug/exists — slug-conflict probe for the upload UI.
sites.get('/:spaceSlug/:siteSlug/exists', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ exists: false })
  return c.json({ exists: true, owned: site.ownerId === user.id })
})

// GET /api/sites/:spaceSlug/:siteSlug — viewer metadata + a token-gated content URL.
// Reads the session directly (not requireAuth) so the not-found / forbidden shapes are returned
// as JSON the viewer can act on rather than a redirect.
sites.get('/:spaceSlug/:siteSlug', async (c) => {
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)

  const user = await readSession(c)
  const isMember = user ? await isSpaceMember(db, site.spaceId, user.id) : false
  const isShared = user ? await resolveIsShared(db, site.id, user.id) : false
  const access = checkAccess(site, user, isMember, isShared)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  // Every tier requires an authenticated viewer (checkAccess 401s otherwise), so `user` is
  // non-null here. The token is bound to `user.id` + scope; the content worker re-runs
  // checkAccess at serve time so a revoked share / tightened tier stops serving immediately.
  if (!user) return c.json({ error: 'forbidden' }, 401)
  const contentUrl = `${c.env.CONTENT_URL}/_t/${await signToken(
    c.env.CONTENT_TOKEN_SECRET,
    user.id,
    `${spaceSlug}/${siteSlug}`,
    CONTENT_TOKEN_TTL,
  )}/${spaceSlug}/${siteSlug}/`

  return c.json({
    id: site.id,
    spaceSlug,
    siteSlug,
    title: site.title,
    visibility: site.visibility,
    status: site.status,
    isOwner: user?.id === site.ownerId,
    contentUrl,
  })
})

// GET /api/sites/:spaceSlug/:siteSlug/shares — owner-only: current explicit share lists.
sites.get('/:spaceSlug/:siteSlug/shares', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)
  return c.json(await listSiteShares(db, site.id))
})

// PUT /api/sites/:spaceSlug/:siteSlug/shares — owner-only: replace the whole share set.
sites.put('/:spaceSlug/:siteSlug/shares', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)

  const body = await c.req.json().catch(() => null)
  const asIds = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []
  const wantUsers = asIds(body?.userIds)
  const wantGroups = asIds(body?.groupIds)

  // Keep only ids that exist (real users; group-type spaces) so a stale id can't fail the
  // batch insert on an FK violation.
  const validUsers = wantUsers.length
    ? (await db.select({ id: users.id }).from(users).where(inArray(users.id, wantUsers))).map((r) => r.id)
    : []
  const validGroups = wantGroups.length
    ? (
        await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(inArray(spaces.id, wantGroups), eq(spaces.type, 'group')))
      ).map((r) => r.id)
    : []

  await replaceSiteShares(db, site.id, validUsers, validGroups)
  return c.json({ ok: true, userIds: validUsers, groupIds: validGroups })
})

// PATCH /api/sites/:spaceSlug/:siteSlug — owner-only update of visibility/title.
sites.patch('/:spaceSlug/:siteSlug', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)
  const { visibility, title } = body as { visibility?: unknown; title?: unknown }

  const patch: { visibility?: Visibility; title?: string | null } = {}
  if (visibility !== undefined) {
    const vis = normalizeVisibility(visibility)
    if (!isVisibility(vis)) return c.json({ error: 'invalid visibility' }, 400)
    patch.visibility = vis
  }
  if (title !== undefined) {
    if (title !== null && typeof title !== 'string') return c.json({ error: 'invalid title' }, 400)
    patch.title = title
  }
  if (Object.keys(patch).length > 0) {
    await db.update(sitesTable).set(patch).where(eq(sitesTable.id, site.id))
  }

  return c.json({ ok: true })
})

// POST /api/sites/:spaceSlug/:siteSlug/move — owner (or superadmin) moves a site to another
// space they belong to. Storage keys are space-agnostic (uuid-prefixed), so only `spaceId`
// changes; shares/comments key off `siteId` and survive. The site's URL becomes /<dest>/<slug>.
sites.post('/:spaceSlug/:siteSlug/move', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id && user.role !== 'superadmin') {
    return c.json({ error: 'forbidden' }, 403)
  }

  const body = await c.req.json().catch(() => null)
  const target = (body as { space?: unknown } | null)?.space
  if (typeof target !== 'string' || !target) return c.json({ error: 'space is required' }, 400)

  const dest = (
    await db.select({ id: spaces.id, slug: spaces.slug }).from(spaces).where(eq(spaces.slug, target)).limit(1)
  )[0]
  if (!dest) return c.json({ error: 'space not found' }, 404)
  if (dest.id === site.spaceId) return c.json({ error: 'site is already in that space' }, 400)
  // Can't dump a site into a space you're not in (superadmin may move anywhere).
  if (user.role !== 'superadmin' && !(await isSpaceMember(db, dest.id, user.id))) {
    return c.json({ error: 'forbidden' }, 403)
  }
  // The (spaceId, slug) unique index would otherwise throw — check first for a clean 409.
  const clash = (
    await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(and(eq(sitesTable.spaceId, dest.id), eq(sitesTable.slug, site.slug)))
      .limit(1)
  )[0]
  if (clash) return c.json({ error: 'a site with this slug already exists in that space', conflict: true }, 409)

  await db.update(sitesTable).set({ spaceId: dest.id }).where(eq(sitesTable.id, site.id))
  return c.json({ ok: true, spaceSlug: dest.slug, siteSlug: site.slug, url: `${c.env.APP_URL}/${dest.slug}/${site.slug}` })
})

// DELETE /api/sites/:spaceSlug/:siteSlug — hard delete (owner or superadmin). Purges R2 first.
sites.delete('/:spaceSlug/:siteSlug', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id && user.role !== 'superadmin') {
    return c.json({ error: 'forbidden' }, 403)
  }

  await deleteSiteObjects(db, c.env.GLANCE_FILES, site.id)
  await db.delete(sitesTable).where(eq(sitesTable.id, site.id)) // FK cascade removes files rows

  return c.json({ ok: true })
})
