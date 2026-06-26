import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { isSpaceMember, listSiteShares, replaceSiteShares, resolveIsShared, sharedSiteIds } from '../db/repo'
import type { Visibility } from '../db/schema'
import { sites as sitesTable, spaces, users } from '../db/schema'
import { checkAccess } from '../lib/access'
import { readSession } from '../lib/session'
import { isValidSlug } from '../lib/slug'
import { deleteSiteObjects } from '../lib/storage'
import { signToken } from '../lib/token'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// Phase 4: site CRUD + viewer metadata. Mounted at /api/sites.

const VISIBILITIES: ReadonlySet<string> = new Set(['private', 'group', 'team', 'public'])
const isVisibility = (v: unknown): v is Visibility => typeof v === 'string' && VISIBILITIES.has(v)

// Gated-content link lifetime. The token rides in the iframe URL path and is inherited by
// relative sub-resources, so it must outlast a real viewing session — 5min broke long views
// and lazily-loaded assets. Re-minted on every viewer load.
const CONTENT_TOKEN_TTL = 60 * 60 // 1h

export const sites = new Hono<AppEnv>()

/** Resolve a site by (spaceSlug, siteSlug), joined to its space. Null if missing. */
async function resolveSite(db: AppEnv['Variables']['db'], spaceSlug: string, siteSlug: string) {
  const rows = await db
    .select({
      id: sitesTable.id,
      spaceId: sitesTable.spaceId,
      slug: sitesTable.slug,
      title: sitesTable.title,
      visibility: sitesTable.visibility,
      status: sitesTable.status,
      ownerId: sitesTable.ownerId,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(and(eq(spaces.slug, spaceSlug), eq(sitesTable.slug, siteSlug)))
    .limit(1)
  return rows[0] ?? null
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
  if (visibility !== undefined && !isVisibility(visibility)) {
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
    visibility: isVisibility(visibility) ? visibility : 'team',
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

// GET /api/sites/team — team-wide upload feed: every team/public site across all spaces,
// newest first, with who uploaded it. Visible to any signed-in member (these tiers are
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
    .where(and(eq(sitesTable.status, 'active'), inArray(sitesTable.visibility, ['team', 'public'])))
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

// GET /api/sites/:spaceSlug/:siteSlug/exists — slug-conflict probe for the upload UI.
sites.get('/:spaceSlug/:siteSlug/exists', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ exists: false })
  return c.json({ exists: true, owned: site.ownerId === user.id })
})

// GET /api/sites/:spaceSlug/:siteSlug — viewer metadata + a (possibly token-gated) content URL.
// OPTIONAL auth: public sites must resolve for logged-out visitors, so we read the session
// directly instead of using requireAuth.
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

  // Non-public access always implies an authenticated user (checkAccess returns 401
  // otherwise), so `user` is non-null on the gated branch. The token is bound to
  // `user.id` + scope; the content worker re-runs checkAccess at serve time.
  const contentUrl =
    site.visibility === 'public' || !user
      ? `${c.env.CONTENT_URL}/${spaceSlug}/${siteSlug}/`
      : `${c.env.CONTENT_URL}/_t/${await signToken(
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
    if (!isVisibility(visibility)) return c.json({ error: 'invalid visibility' }, 400)
    patch.visibility = visibility
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
