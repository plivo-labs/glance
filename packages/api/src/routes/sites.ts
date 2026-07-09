import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  type ShareUser,
  isSpaceMember,
  listSiteShares,
  memberSpaceIds,
  replaceSiteShares,
  resolveIsShared,
  resolveShareRole,
  sharedSiteIds,
} from '../db/repo'
import type { Visibility } from '../db/schema'
import { files as filesTable, sites as sitesTable, spaces, users } from '../db/schema'
import { canReplace, checkAccess } from '../lib/access'
import { allAudioSiteIds } from '../lib/site-audio'
import { readSessionOrBearer } from '../lib/session'
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

// D1 caps a single statement at 100 bound parameters, so an `inArray` over a candidate id list
// must be split into batches and the per-batch results unioned — otherwise a large member-space /
// shared-site list throws. Kept under 100 to leave room for the query's other bound values.
const D1_MAX_IN = 90

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

// Escape LIKE metacharacters (`%`, `_`, and the `\` escape char itself) so a user's literal
// `%`/`_` can't act as wildcards. Pair the bound value with `ESCAPE '\'` in the query.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

// createdAt is ISO-8601, so a plain string compare orders chronologically. Newest first.
function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
}

// SQLite/D1 UNIQUE-constraint violation (both bun:sqlite and D1's wrapped D1_ERROR carry the text).
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique constraint failed/i.test(msg)
}

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
 * cmdk site search. Bounded candidate queries over *active* sites the caller might open
 * (owner / member-space / team / explicitly-shared; superadmin ⇒ all active) — chunked + unioned
 * to stay under D1's bound-parameter cap — then a final in-memory checkAccess pass (the single
 * source of truth) using precomputed membership/share sets so it stays O(rows), not N+1.
 * "Openable" semantics: the result is exactly what checkAccess admits. q matches site title/slug
 * or its space slug/name (LIKE metacharacters in q are escaped).
 */
export async function searchSites(
  db: AppEnv['Variables']['db'],
  user: SessionUser,
  q: string,
  limit = 20,
): Promise<SearchRow[]> {
  const term = `%${escapeLike(q.trim().toLowerCase())}%`
  const qMatch = sql`(lower(${sitesTable.title}) like ${term} escape '\\' or lower(${sitesTable.slug}) like ${term} escape '\\' or lower(${spaces.slug}) like ${term} escape '\\' or lower(${spaces.name}) like ${term} escape '\\')`

  const isSuper = user.role === 'superadmin'
  const memberSpaces = isSuper ? new Set<string>() : await memberSpaceIds(db, user.id)
  const shared = isSuper ? new Set<string>() : await sharedSiteIds(db, user.id)

  // Candidate reach as a set of bounded WHERE clauses, unioned in memory: `X AND (A OR B OR C)`
  // ≡ union of `X AND A`, `X AND B`, `X AND C`, and no single statement's `inArray` can exceed
  // D1's 100-param cap (member-space / shared id lists are chunked). superadmin ⇒ every active
  // match (undefined reach, which `and` drops).
  const active = eq(sitesTable.status, 'active')
  const reaches = isSuper
    ? [undefined]
    : [
        or(eq(sitesTable.ownerId, user.id), eq(sitesTable.visibility, 'team')),
        ...chunk([...memberSpaces], D1_MAX_IN).map((ids) => inArray(sitesTable.spaceId, ids)),
        ...chunk([...shared], D1_MAX_IN).map((ids) => inArray(sitesTable.id, ids)),
      ]

  const cols = {
    id: sitesTable.id,
    spaceId: sitesTable.spaceId,
    spaceSlug: spaces.slug,
    siteSlug: sitesTable.slug,
    title: sitesTable.title,
    visibility: sitesTable.visibility,
    status: sitesTable.status,
    ownerId: sitesTable.ownerId,
    createdAt: sitesTable.createdAt,
  }
  const batches = await Promise.all(
    reaches.map((reach) =>
      db
        .select(cols)
        .from(sitesTable)
        .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
        .where(and(active, qMatch, reach))
        .orderBy(desc(sitesTable.createdAt))
        .limit(SEARCH_SCAN_CAP),
    ),
  )

  // Union the batches (dedupe by id — a row can satisfy more than one reach), newest first, then
  // the checkAccess pass (the single source of truth) over precomputed membership/share sets.
  const byId = new Map<string, SearchRow>()
  for (const rows of batches) for (const r of rows) byId.set(r.id, r)
  return [...byId.values()]
    .sort(byCreatedAtDesc)
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
  if (existing) return c.json({ error: 'site already exists', conflict: true }, 409)

  const id = crypto.randomUUID()
  try {
    await db.insert(sitesTable).values({
      id,
      spaceId: space.id,
      slug: siteSlug,
      title: typeof title === 'string' ? title : null,
      visibility: isVisibility(vis) ? vis : 'team',
      ownerId: user.id,
    })
  } catch (err) {
    // Lost the check-then-insert race on unique(spaceId, slug) to a concurrent create — return the
    // same 409 the pre-check would, not a 500.
    if (isUniqueConstraintError(err)) return c.json({ error: 'site already exists', conflict: true }, 409)
    throw err
  }

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

  const audioSet = await allAudioSiteIds(db, rows.map((r) => r.id))
  return c.json(
    rows.map((r) => ({
      id: r.id,
      spaceSlug: r.spaceSlug,
      siteSlug: r.slug,
      title: r.title,
      visibility: r.visibility,
      status: r.status,
      audio: audioSet.has(r.id),
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
  // Chunk the shared-id list under D1's 100-param cap and union — ids are unique across chunks,
  // so no dedupe is needed; re-sort newest-first in memory (per-batch order is lost on flatten).
  const batches = await Promise.all(
    chunk(ids, D1_MAX_IN).map((batch) =>
      db
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
        .where(inArray(sitesTable.id, batch)),
    ),
  )
  const rows = batches.flat().sort(byCreatedAtDesc)
  const visible = rows.filter((r) => r.status === 'active' && r.ownerId !== user.id)
  const audioSet = await allAudioSiteIds(db, visible.map((r) => r.id))
  return c.json(
    visible.map((r) => ({
      id: r.id,
      spaceSlug: r.spaceSlug,
      siteSlug: r.slug,
      title: r.title,
      visibility: r.visibility,
      status: r.status,
      audio: audioSet.has(r.id),
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
  const audioSet = await allAudioSiteIds(db, rows.map((r) => r.id))
  return c.json(
    rows.map((r) => ({
      id: r.id,
      spaceSlug: r.spaceSlug,
      siteSlug: r.slug,
      title: r.title,
      visibility: r.visibility,
      status: r.status,
      audio: audioSet.has(r.id),
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
  // Existence is disclosed only to someone who could legitimately act on it — the site's space
  // members (slug availability is per-space), its owner, a superadmin, OR a direct editor grantee
  // (typically NOT a space member — without this a non-member editor gets exists:false, the CLI
  // then tries CREATE and 403s). Anyone else gets the same not-found shape so an unauthorized caller
  // can't probe cross-space for a site's existence.
  const isOwner = site.ownerId === user.id
  const role = isOwner || user.role === 'superadmin' ? null : await resolveShareRole(db, site.id, user.id)
  const replaceable = canReplace(user, site, role)
  const authorized = replaceable || (await isSpaceMember(db, site.spaceId, user.id))
  if (!authorized) return c.json({ exists: false })
  return c.json({ exists: true, owned: isOwner, canReplace: replaceable, contentVersion: site.contentVersion })
})

// GET /api/sites/:spaceSlug/:siteSlug — viewer metadata + a token-gated content URL.
// Reads the session directly (not requireAuth) so the not-found / forbidden shapes are returned
// as JSON the viewer can act on rather than a redirect.
sites.get('/:spaceSlug/:siteSlug', async (c) => {
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()

  // FCP hotpath: the session read is independent of the site lookup, so resolve both concurrently.
  // Cookie (browser viewer) OR CLI Bearer token (`glance read`) — both mint the same gated URL.
  const [site, user] = await Promise.all([resolveSite(db, spaceSlug, siteSlug), readSessionOrBearer(c)])
  // Existence (404) is still decided before any auth-dependent branch, so a missing site never
  // leaks — running the session read early doesn't change the not-found-before-auth ordering.
  if (!site) return c.json({ error: 'not found' }, 404)

  const [isMember, isShared, role, siteFiles] = user
    ? await Promise.all([
        isSpaceMember(db, site.spaceId, user.id),
        resolveIsShared(db, site.id, user.id),
        resolveShareRole(db, site.id, user.id),
        db.select({ path: filesTable.path }).from(filesTable).where(eq(filesTable.siteId, site.id)),
      ])
    : [false, false, null, [] as { path: string }[]]
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

  // Manifest gate: only someone who can REPLACE the content (owner / superadmin / editor) gets the
  // file list + contentVersion — the pull-and-redeploy payload. A plain viewer sees their canReplace:
  // false and no manifest, so they can't enumerate the site's files.
  const replaceable = canReplace(user, site, role)
  return c.json({
    id: site.id,
    spaceSlug,
    siteSlug,
    title: site.title,
    visibility: site.visibility,
    status: site.status,
    isOwner: user.id === site.ownerId,
    canReplace: replaceable,
    ...(role ? { role } : {}),
    contentUrl,
    indexPath: resolveIndexPath(siteFiles.map((f) => f.path)),
    ...(replaceable ? { files: siteFiles.map((f) => f.path), contentVersion: site.contentVersion } : {}),
  })
})

// The file the root URL ('' splat) actually serves, mirroring the content worker's root
// resolution (content.ts): an explicit index.html wins, else a lone uploaded file is served at
// the root, else '' (a multi-file site with no index shows the directory listing). The viewer
// reads this so a single-file audio site picks the native player at its root URL — not just at
// the explicit `/…/recording.webm` path — and anchors comments to the same resolved path either way.
function resolveIndexPath(paths: string[]): string {
  if (paths.includes('index.html')) return 'index.html'
  return paths.length === 1 ? paths[0] : ''
}

// Normalize a PUT /shares body into role-aware user grants + view-only group ids. Pure (no DB), so
// it's unit-testable and keeps every cast out of the request path. Accepts the new `users:[{id,role}]`
// shape and the legacy `userIds:[id]` list (defaulted to viewer; `users` wins on a collision). Groups
// arrive as `groupIds:[id]` or `groups:[{id}]` and are ALWAYS view-only — an editor role on a group is
// a client error (there is no role column on site_group_shares), surfaced as `{ error }`.
export function parseShareGrants(body: unknown): { users: ShareUser[]; groupIds: string[] } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const asIds = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []
  const groupObjs = Array.isArray(b.groups) ? (b.groups as { id?: unknown; role?: unknown }[]) : []
  if (groupObjs.some((g) => g?.role === 'editor')) return { error: 'groups cannot be granted editor' }

  const roles = new Map<string, 'viewer' | 'editor'>()
  if (Array.isArray(b.users)) {
    for (const u of b.users as { id?: unknown; role?: unknown }[]) {
      if (typeof u?.id === 'string') roles.set(u.id, u.role === 'editor' ? 'editor' : 'viewer')
    }
  }
  for (const id of asIds(b.userIds)) if (!roles.has(id)) roles.set(id, 'viewer')

  const groupIds = [...new Set([...asIds(b.groupIds), ...asIds(groupObjs.map((g) => g?.id))])]
  return { users: [...roles].map(([userId, role]) => ({ userId, role })), groupIds }
}

// GET /api/sites/:spaceSlug/:siteSlug/shares — owner-only: current explicit share lists.
sites.get('/:spaceSlug/:siteSlug/shares', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id && user.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)
  const shares = await listSiteShares(db, site.id)
  // Boundary shape: expose users as {id, role} (mirrors the PUT input); keep flat userIds/groupIds
  // for the legacy web dialog.
  return c.json({
    userIds: shares.userIds,
    groupIds: shares.groupIds,
    users: shares.users.map((u) => ({ id: u.userId, role: u.role })),
  })
})

// PUT /api/sites/:spaceSlug/:siteSlug/shares — owner-only: replace the whole share set.
sites.put('/:spaceSlug/:siteSlug/shares', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id && user.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)

  const grants = parseShareGrants(await c.req.json().catch(() => null))
  if ('error' in grants) return c.json({ error: grants.error }, 400)

  // Keep only ids that exist (real users; group-type spaces) so a stale id can't fail the batch
  // insert on an FK violation.
  const wantUsers = grants.users.map((u) => u.userId)
  const present = wantUsers.length
    ? new Set((await db.select({ id: users.id }).from(users).where(inArray(users.id, wantUsers))).map((r) => r.id))
    : new Set<string>()
  const validUsers = grants.users.filter((u) => present.has(u.userId))
  const validGroups = grants.groupIds.length
    ? (
        await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(inArray(spaces.id, grants.groupIds), eq(spaces.type, 'group')))
      ).map((r) => r.id)
    : []

  await replaceSiteShares(db, site.id, validUsers, validGroups)
  return c.json({
    ok: true,
    userIds: validUsers.map((u) => u.userId),
    groupIds: validGroups,
    users: validUsers.map((u) => ({ id: u.userId, role: u.role })),
  })
})

// PATCH /api/sites/:spaceSlug/:siteSlug — owner-only update of visibility/title.
sites.patch('/:spaceSlug/:siteSlug', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id && user.role !== 'superadmin') return c.json({ error: 'forbidden' }, 403)

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
