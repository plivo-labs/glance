import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { foldMemberSpaceIds, foldSharedSiteRoles, memberSpaceIdsStmt, sharedSiteRoleStmts } from '../db/repo'
import { siteStars, sites as sitesTable, spaces } from '../db/schema'
import { checkAccess } from '../lib/access'
import { batchAll, chunk } from '../lib/d1'
import { siteFeedColumns, toFeedRow } from '../lib/site-feed'
import type { ResolvedSite } from '../lib/site-access'
import { fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'
import { SHARED_FEED_CHUNK } from './sites'

// Star toggle. Mounted at /api/sites alongside comments/summary, so the 3-segment
// `/:space/:site/star` path falls through the site routes' own 2-segment matchers.

export const stars = new Hono<AppEnv>()

/** Resolve the site and authorize the caller, or hand back the response to return. The route adds
 *  exactly ONE rule to `checkAccess`: a `private` site is not starrable, not even by its owner — a
 *  star pins something you come back to through a shared surface, and private has none. Everything
 *  else (404 before 403, archived → 410) is checkAccess's precedence, inherited not re-implemented. */
async function starrable(c: Context<AppEnv>): Promise<ResolvedSite | Response> {
  const user = c.get('user')
  const { space, site: siteSlug } = c.req.param()
  const { facts } = await fetchAccessFacts(c.get('db'), space, siteSlug, user.id)
  const { site, access } = siteAccessFromFacts(facts, user)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)
  if (site.visibility === 'private') return c.json({ error: 'private sites cannot be starred' }, 400)
  return site
}

// GET /api/sites/starred — the feed behind the Starred tab. Two D1 requests, the same shape
// /shared uses: the star layer, then the site rows with the feed's correlated scalars folded in.
//
// A star row grants NOTHING. Reach is re-decided HERE, at read time, by the same `checkAccess`
// every other surface runs — over membership/share sets precomputed in the first batch, so the
// pass stays O(rows) rather than a per-row lookup. That is what lets a site you starred and then
// lost access to simply vanish from the feed while its row waits for a flip back. `private` is
// excluded on top of checkAccess: the toggle refuses to create such a star, and an owner's own
// private site would otherwise pass the check and reappear here after a visibility flip.
stars.get('/starred', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const [starRows, memberRows, direct, viaGroup] = await batchAll(db, [
    db
      .select({ siteId: siteStars.siteId, starredAt: sql<string>`${siteStars.createdAt}`.as('starredAt') })
      .from(siteStars)
      .where(eq(siteStars.userId, user.id))
      .orderBy(desc(siteStars.createdAt)),
    memberSpaceIdsStmt(db, user.id),
    ...sharedSiteRoleStmts(db, user.id),
  ])
  // No explicit zero-star early-out: an empty id list chunks to no statements and `batchAll`
  // answers without touching D1, so the second round trip is already skipped.
  const order = new Map(starRows.map((r, i) => [r.siteId, i]))
  const memberSpaces = foldMemberSpaceIds(memberRows)
  const shared = new Set(foldSharedSiteRoles(direct, viaGroup).keys())
  const rowChunks = await batchAll(
    db,
    chunk([...order.keys()], SHARED_FEED_CHUNK).map((ids) =>
      db
        .select({ ...siteFeedColumns(user.id), spaceId: sitesTable.spaceId, ownerId: sitesTable.ownerId })
        .from(sitesTable)
        .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
        .where(inArray(sitesTable.id, ids)),
    ),
  )
  const visible = rowChunks
    .flat()
    .filter(
      (r) =>
        r.visibility !== 'private' &&
        checkAccess(r, user, memberSpaces.has(r.spaceId), shared.has(r.id)).ok,
    )
    // Per-chunk order is lost on flatten; re-impose the STAR order (newest star first).
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return c.json(visible.map((r) => toFeedRow(r, c.env.APP_URL)))
})

stars.use('/:space/:site/star', requireAuth)

// Both verbs are no-op-safe and return the RESULTING state, so a double-click (or a retry of a
// request whose response was lost) converges instead of erroring: the composite PK absorbs the
// second insert, and a delete of nothing is still "not starred".
stars.post('/:space/:site/star', async (c) => {
  const site = await starrable(c)
  if (site instanceof Response) return site
  await c
    .get('db')
    .insert(siteStars)
    .values({ siteId: site.id, userId: c.get('user').id })
    .onConflictDoNothing()
  return c.json({ starred: true })
})

stars.delete('/:space/:site/star', async (c) => {
  const site = await starrable(c)
  if (site instanceof Response) return site
  await c
    .get('db')
    .delete(siteStars)
    .where(and(eq(siteStars.siteId, site.id), eq(siteStars.userId, c.get('user').id)))
  return c.json({ starred: false })
})
