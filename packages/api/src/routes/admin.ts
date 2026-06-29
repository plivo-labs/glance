import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { sites, spaceMembers, spaces as spacesTable, users } from '../db/schema'
import { deleteSiteObjects } from '../lib/storage'
import { isVisibility, normalizeVisibility } from '../lib/visibility'
import { requireAuth, requireSuperAdmin } from '../middleware/auth'
import type { AppEnv } from '../types'

export const admin = new Hono<AppEnv>()

const PAGE_SIZE = 50

// Every admin route requires a superadmin: requireAuth first (401 if anonymous),
// then requireSuperAdmin (403 if a non-superadmin member).
admin.use('*', requireAuth, requireSuperAdmin)

// GET /api/admin/sites — every site, newest first, with optional status/visibility filters
// and 50-per-page pagination. Joins spaces for the human-readable space slug.
admin.get('/sites', async (c) => {
  const db = c.get('db')

  const statusParam = c.req.query('status')
  const visibilityParam = c.req.query('visibility')
  const pageParam = Number.parseInt(c.req.query('page') ?? '', 10)
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1

  const filters = []
  if (statusParam === 'active' || statusParam === 'archived') filters.push(eq(sites.status, statusParam))
  const vis = normalizeVisibility(visibilityParam)
  if (isVisibility(vis)) filters.push(eq(sites.visibility, vis))
  const where = filters.length > 0 ? and(...filters) : undefined

  const rows = await db
    .select({
      id: sites.id,
      spaceSlug: spacesTable.slug,
      siteSlug: sites.slug,
      title: sites.title,
      visibility: sites.visibility,
      status: sites.status,
      ownerId: sites.ownerId,
      createdAt: sites.createdAt,
    })
    .from(sites)
    .innerJoin(spacesTable, eq(sites.spaceId, spacesTable.id))
    .where(where)
    .orderBy(desc(sites.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)

  const counted = await db.select({ count: sql<number>`count(*)` }).from(sites).where(where)
  const total = Number(counted[0]?.count ?? 0)

  return c.json({ sites: rows, page, pageSize: PAGE_SIZE, total })
})

// PATCH /api/admin/sites/:id/archive — soft-archive a site. 404 if missing.
admin.patch('/sites/:id/archive', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const existing = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1)
  if (existing.length === 0) return c.json({ error: 'site not found' }, 404)
  await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, id))
  return c.json({ ok: true })
})

// PATCH /api/admin/sites/:id/restore — reactivate an archived site. 404 if missing.
admin.patch('/sites/:id/restore', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const existing = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1)
  if (existing.length === 0) return c.json({ error: 'site not found' }, 404)
  await db.update(sites).set({ status: 'active' }).where(eq(sites.id, id))
  return c.json({ ok: true })
})

// DELETE /api/admin/sites/:id — hard delete. Purge R2 objects first, then the row
// (the FK cascade removes the site's file rows).
admin.delete('/sites/:id', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const existing = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1)
  if (existing.length === 0) return c.json({ error: 'site not found' }, 404)
  await deleteSiteObjects(db, c.env.GLANCE_FILES, id)
  await db.delete(sites).where(eq(sites.id, id))
  return c.json({ ok: true })
})

// GET /api/admin/spaces — every space with its member count.
admin.get('/spaces', async (c) => {
  const db = c.get('db')
  const rows = await db
    .select({
      id: spacesTable.id,
      slug: spacesTable.slug,
      name: spacesTable.name,
      type: spacesTable.type,
      memberCount: sql<number>`count(${spaceMembers.userId})`,
      createdAt: spacesTable.createdAt,
    })
    .from(spacesTable)
    .leftJoin(spaceMembers, eq(spaceMembers.spaceId, spacesTable.id))
    .groupBy(spacesTable.id)
    .orderBy(desc(spacesTable.createdAt))
  return c.json(rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) })))
})

// GET /api/admin/users — every user.
admin.get('/users', async (c) => {
  const db = c.get('db')
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
  return c.json(rows)
})
