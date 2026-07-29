import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { siteStars } from '../db/schema'
import type { ResolvedSite } from '../lib/site-access'
import { fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

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
