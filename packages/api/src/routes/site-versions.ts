import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { files, siteVersionFiles, siteVersions, sites, users } from '../db/schema'
import { extractHtmlMeta, NO_META, pickEntry } from '../lib/extract'
import { resolveSite } from '../lib/site-access'
import { copyObjects, deleteKeys } from '../lib/storage'
import { snapshotSiteFiles } from '../lib/versions'
import { requireAuth, requireControlGrant } from '../middleware/auth'
import type { AppEnv } from '../types'
import { MAX_FILE_COUNT } from './upload'

// Version history of a site (see lib/versions.ts), mounted by sites.ts on /api/sites. OWNER ONLY, like
// shares/move: a superadmin's custodial powers stop at the content, and a version IS the content
// (lib/access.ts — no role bypass).
export const versions = new Hono<AppEnv>()

// GET /api/sites/:spaceSlug/:siteSlug/versions — the snapshots, newest first. No preview, no diff.
versions.get('/:spaceSlug/:siteSlug/versions', requireAuth, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)

  const rows = await db
    .select({
      id: siteVersions.id,
      version: siteVersions.version,
      createdAt: siteVersions.createdAt,
      fileCount: siteVersions.fileCount,
      totalSize: siteVersions.totalSize,
      byId: users.id,
      byName: users.name,
      byEmail: users.email,
    })
    .from(siteVersions)
    .leftJoin(users, eq(siteVersions.createdBy, users.id))
    .where(eq(siteVersions.siteId, site.id))
    .orderBy(desc(siteVersions.createdAt), desc(siteVersions.version))
  return c.json({
    versions: rows.map(({ byId, byName, byEmail, ...v }) => ({
      ...v,
      createdBy: byId === null ? null : { id: byId, name: byName, email: byEmail },
    })),
  })
})

// POST /api/sites/:spaceSlug/:siteSlug/versions/:versionId/restore — make a version the live content.
// The version's objects are COPIED to a fresh prefix (the version keeps its own, so it stays
// restorable and the one-object-one-owner invariant holds), then the live rows are swapped in one
// batch that ALSO snapshots the content being replaced as a new version — a restore is reversible.
versions.post('/:spaceSlug/:siteSlug/versions/:versionId/restore', requireAuth, requireControlGrant, async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug, versionId } = c.req.param()
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (site.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)
  if (site.status !== 'active') return c.json({ error: 'site is not active', status: site.status }, 409)

  // Scoped to THIS site: a bare id lookup would let the owner of one site restore another's version.
  const version = (
    await db
      .select()
      .from(siteVersions)
      .where(and(eq(siteVersions.id, versionId), eq(siteVersions.siteId, site.id)))
      .limit(1)
  )[0]
  if (!version) return c.json({ error: 'version not found' }, 404)
  // Same bound as upload: one get + one put per file against the subrequest budget.
  if (version.fileCount > MAX_FILE_COUNT) return c.json({ error: 'too many files', max: MAX_FILE_COUNT }, 400)

  const source = await db
    .select({
      path: siteVersionFiles.path,
      storageKey: siteVersionFiles.storageKey,
      mimeType: siteVersionFiles.mimeType,
      size: siteVersionFiles.size,
    })
    .from(siteVersionFiles)
    .where(eq(siteVersionFiles.versionId, version.id))
  if (source.length === 0) return c.json({ error: 'version has no files' }, 409)

  // The blurb describes the bytes, so re-derive it from the version's entry (the version rows have
  // nowhere to keep the old one) — otherwise the unfurl card would keep describing the replaced page.
  // Read from the SOURCE object, BEFORE the copy: a failure here then leaves nothing written to R2.
  const entry = pickEntry(source)
  const entryObject = entry ? await c.env.GLANCE_FILES.get(entry.storageKey) : null
  const { description } = entry && entryObject ? await extractHtmlMeta(entry, await entryObject.text()) : NO_META

  // Copy BEFORE any D1 write (as fork does): a missing object aborts with nothing committed.
  const copied = await copyObjects(c.env.GLANCE_FILES, source, crypto.randomUUID())
  const newKeys = copied.map((f) => f.storageKey)

  try {
    await db.batch([
      ...snapshotSiteFiles(db, { siteId: site.id, createdBy: user.id }),
      db.delete(files).where(eq(files.siteId, site.id)),
      ...copied.map((f) => db.insert(files).values({ id: crypto.randomUUID(), siteId: site.id, ...f })),
      db
        .update(sites)
        .set({
          // Bump like any replace, so an editor holding a stale expectedVersion gets a 409 rather
          // than silently overwriting the restored content.
          contentVersion: sql`${sites.contentVersion} + 1`,
          lastReplacedBy: user.id,
          updatedAt: new Date().toISOString(),
          description,
        })
        .where(eq(sites.id, site.id)),
    ])
  } catch (err) {
    await deleteKeys(c.env.GLANCE_FILES, newKeys)
    throw err
  }
  return c.json({ ok: true, restoredVersion: version.version, fileCount: copied.length })
})
