import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { createSpace, foldSharedSiteRoles, sharedSiteRoleStmts } from '../db/repo'
import { sites, spaceMembers, spaces as spacesTable, users } from '../db/schema'
import { checkAccess } from '../lib/access'
import { batchAll } from '../lib/d1'
import { siteFeedColumns, toFeedRow } from '../lib/site-feed'
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

/** Caller-is-a-member-of-the-space-at-`slug` as one SELECT (membership joined through the slug, so
 *  it needs no prior space-row read and can share a db.batch with it). Missing space → empty. */
function memberOfSlugStmt(db: DrizzleD1Database, slug: string, userId: string) {
  return db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .innerJoin(spacesTable, eq(spaceMembers.spaceId, spacesTable.id))
    .where(and(eq(spacesTable.slug, slug), eq(spaceMembers.userId, userId)))
    .limit(1)
}

// GET /api/spaces/:slug — metadata + member count + caller membership, in ONE post-auth D1 request:
// all three reads are independent non-failing SELECTs keyed on the slug, so they share a db.batch
// and the 404 for a missing space is decided post-batch on the space row alone.
spaces.get('/:slug', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')
  const [spaceRows, counted, memberRows] = await batchAll(db, [
    db.select().from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1),
    db
      // Aliased: real D1 `.batch()` maps rows by column NAME and SQLite's name for an
      // unaliased expression is undefined (harness guard enforces the alias).
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(spaceMembers)
      .innerJoin(spacesTable, eq(spaceMembers.spaceId, spacesTable.id))
      .where(eq(spacesTable.slug, slug)),
    memberOfSlugStmt(db, slug, user.id),
  ])
  const space = spaceRows[0]
  if (!space) return c.json({ error: 'space not found' }, 404)

  const memberCount = Number(counted[0]?.count ?? 0)
  const isMember = memberRows.length > 0
  return c.json({ id: space.id, slug: space.slug, name: space.name, type: space.type, memberCount, isMember })
})

// GET /api/spaces/:slug/sites — sites in the space the caller can actually access, in ONE post-auth
// D1 request. Every read is keyed on the slug (or the caller) rather than a prior space-row read, so
// space existence, share reach, membership, and the site rows — with the pure-audio badge folded in
// as a correlated scalar (pureAudioSql, as /mine and /team do) — all travel in a single db.batch.
// Each statement is a non-failing SELECT (missing space → empty rows), so the 404 is decided
// post-batch on the space row alone. Visibility filtering stays in JS (checkAccess); computing the
// audio scalar for rows the caller can't see is harmless — only visible rows reach the response.
spaces.get('/:slug/sites', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const slug = c.req.param('slug')
  const [directStmt, viaGroupStmt] = sharedSiteRoleStmts(db, user.id)
  const [spaceRows, direct, viaGroup, memberRows, rows] = await batchAll(db, [
    db.select({ id: spacesTable.id }).from(spacesTable).where(eq(spacesTable.slug, slug)).limit(1),
    directStmt,
    viaGroupStmt,
    memberOfSlugStmt(db, slug, user.id),
    db
      .select({
        ...siteFeedColumns(),
        ownerId: sites.ownerId,
      })
      .from(sites)
      .innerJoin(spacesTable, eq(sites.spaceId, spacesTable.id))
      .where(eq(spacesTable.slug, slug))
      .orderBy(desc(sites.createdAt)),
  ])
  if (spaceRows.length === 0) return c.json({ error: 'space not found' }, 404)

  const isMember = memberRows.length > 0
  const shared = foldSharedSiteRoles(direct, viaGroup)
  const visible = rows.filter((s) => checkAccess(s, user, isMember, shared.has(s.id)).ok)
  return c.json(
    visible.map((s) => ({
      ...toFeedRow(s, c.env.APP_URL),
      isOwner: s.ownerId === user.id,
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
