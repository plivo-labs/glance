import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createSpace, isSpaceMember, sharedSiteIds } from '../db/repo'
import { sites, spaceMembers, spaces as spacesTable, users } from '../db/schema'
import { checkAccess } from '../lib/access'
import { allAudioSiteIds } from '../lib/site-audio'
import { deleteSpaceObjects } from '../lib/storage'
import { isValidSlug } from '../lib/slug'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export const spaces = new Hono<AppEnv>()

/** True for a SQLite/D1 UNIQUE-constraint violation (message carries "UNIQUE constraint failed"
 *  in both the bun:sqlite harness and D1's wrapped `D1_ERROR`) — a re-invite hitting the
 *  space_members composite PK. Distinguishes an idempotent no-op from a real write failure. */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique constraint failed/i.test(msg)
}

// POST /api/spaces — create a GROUP space. Creator is added as a member (atomic).
spaces.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const body = await c.req.json().catch(() => null)
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!slug || !name) return c.json({ error: 'slug and name are required' }, 400)
  if (!isValidSlug(slug)) return c.json({ error: 'invalid slug' }, 400)

  const existing = await db.select({ id: spacesTable.id }).from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1)
  if (existing.length > 0) return c.json({ error: 'slug already taken' }, 409)

  const id = await createSpace(db, { slug, name, type: 'group', createdBy: user.id })
  return c.json({ id, slug, name, type: 'group' as const }, 201)
})

// GET /api/spaces/mine — spaces the caller belongs to, sorted by name.
spaces.get('/mine', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const rows = await db
    .select({ id: spacesTable.id, slug: spacesTable.slug, name: spacesTable.name, type: spacesTable.type })
    .from(spaceMembers)
    .innerJoin(spacesTable, eq(spaceMembers.spaceId, spacesTable.id))
    .where(eq(spaceMembers.userId, user.id))
    .orderBy(spacesTable.name)
  return c.json(rows)
})

// GET /api/spaces/:slug — metadata + member count + caller membership.
spaces.get('/:slug', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')
  const space = (await db.select().from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1))[0]
  if (!space) return c.json({ error: 'space not found' }, 404)

  const counted = await db
    .select({ count: sql<number>`count(*)` })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, space.id))
  const memberCount = Number(counted[0]?.count ?? 0)
  const isMember = await isSpaceMember(db, space.id, user.id)
  return c.json({ id: space.id, slug: space.slug, name: space.name, type: space.type, memberCount, isMember })
})

// GET /api/spaces/:slug/sites — sites in the space the caller can actually access.
spaces.get('/:slug/sites', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')
  const space = (await db.select().from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1))[0]
  if (!space) return c.json({ error: 'space not found' }, 404)

  const isMember = await isSpaceMember(db, space.id, user.id)
  const shared = await sharedSiteIds(db, user.id)
  const rows = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      title: sites.title,
      visibility: sites.visibility,
      status: sites.status,
      ownerId: sites.ownerId,
      createdAt: sites.createdAt,
    })
    .from(sites)
    .where(eq(sites.spaceId, space.id))
    .orderBy(desc(sites.createdAt))

  const visible = rows.filter((s) => checkAccess(s, user, isMember, shared.has(s.id)).ok)
  const audioSet = await allAudioSiteIds(db, visible.map((s) => s.id))
  return c.json(
    visible.map((s) => ({
      id: s.id,
      spaceSlug: slug,
      siteSlug: s.slug,
      title: s.title,
      visibility: s.visibility,
      status: s.status,
      isOwner: s.ownerId === user.id,
      audio: audioSet.has(s.id),
      url: `${c.env.APP_URL}/${slug}/${s.slug}`,
      createdAt: s.createdAt,
    })),
  )
})

// POST /api/spaces/:slug/members — invite a user by email (owner only).
spaces.post('/:slug/members', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')
  const body = await c.req.json().catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!email) return c.json({ error: 'email is required' }, 400)

  const space = (await db.select().from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1))[0]
  if (!space) return c.json({ error: 'space not found' }, 404)
  if (space.createdBy !== user.id) return c.json({ error: 'forbidden' }, 403)
  // A personal space is a single-owner namespace — it has no roster to invite into.
  if (space.type === 'personal') return c.json({ error: 'cannot invite members to a personal space' }, 409)

  const target = (
    await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1)
  )[0]
  if (!target) return c.json({ error: 'user not found — they must sign in once first' }, 404)

  // Idempotent invite: ONLY a composite-PK collision (already a member) is a no-op success. Any
  // other write failure is real — surface it as a 5xx rather than masking it behind a false ok.
  try {
    await db.insert(spaceMembers).values({ spaceId: space.id, userId: target.id })
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err
  }
  return c.json({ ok: true })
})

// DELETE /api/spaces/:slug/members/:userId — remove a member (owner only; cannot remove owner).
spaces.delete('/:slug/members/:userId', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')
  const userId = c.req.param('userId')

  const space = (await db.select().from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1))[0]
  if (!space) return c.json({ error: 'space not found' }, 404)
  if (space.createdBy !== user.id) return c.json({ error: 'forbidden' }, 403)
  if (userId === space.createdBy) return c.json({ error: 'cannot remove the space owner' }, 400)

  await db
    .delete(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)))
  return c.json({ ok: true })
})

// DELETE /api/spaces/:slug — delete a space (owner or superadmin). Personal spaces are protected.
spaces.delete('/:slug', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')

  const space = (await db.select().from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1))[0]
  if (!space) return c.json({ error: 'space not found' }, 404)
  if (space.type === 'personal') return c.json({ error: 'personal space cannot be deleted' }, 403)
  if (user.id !== space.createdBy && user.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)

  // A group-space delete hard-destroys EVERY site in it (FK cascade + R2 purge), including sites
  // owned by OTHER members — which isn't the owner's to erase. Refuse when any foreign-owned site
  // is present; those owners must move or delete their sites first. Superadmin bypasses.
  if (user.role !== 'superadmin') {
    const foreign = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.spaceId, space.id), ne(sites.ownerId, user.id)))
      .limit(1)
    if (foreign.length > 0)
      return c.json({ error: 'space has sites owned by other members — they must move or delete them first' }, 409)
  }

  // Purge R2 objects in ONE key query + batched deletes before the FK cascade removes site + file
  // rows. (The old per-site deleteSiteObjects loop did 2+ subrequests/site → blew the 50-subrequest
  // free-plan cap mid-loop on a large space, 500ing with a partial destroy.)
  await deleteSpaceObjects(db, c.env.GLANCE_FILES, space.id)
  await db.delete(spacesTable).where(eq(spacesTable.id, space.id))
  return c.json({ ok: true })
})
