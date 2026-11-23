import { eq, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { files, siteVersionFiles, siteVersions, sites } from '../db/schema'

/**
 * The two statements that MOVE a site's current file rows into a new version. Spread them into the
 * same `db.batch` as the swap, BEFORE the `delete(files)`: the snapshot then reads exactly the rows
 * the batch deletes (atomic under D1's batch transaction — no stale pre-read, no 100-bind cap, and a
 * racing replace can never delete rows this one never snapshotted). The R2 objects stay put; only
 * ownership of their keys moves from `files` to `site_version_files`.
 *
 * A site with no file rows snapshots nothing (the join yields no row, so no version is created).
 * `version` defaults to the site's contentVersion AT BATCH TIME (the owner path, ahead of its bump);
 * the editor path passes `expectedVersion` explicitly because its CAS claim already bumped the column.
 * `createdAt` is the snapshot time — retention ages versions by when they were superseded.
 */
export function snapshotSiteFiles(
  db: DrizzleD1Database,
  o: { siteId: string; createdBy: string; version?: number },
) {
  const id = crypto.randomUUID()
  return [
    db.insert(siteVersions).select(
      db
        .select({
          id: sql<string>`${id}`.as('id'),
          siteId: sites.id,
          version: (o.version === undefined ? sql<number>`${sites.contentVersion}` : sql<number>`${o.version}`).as('version'),
          createdAt: sql<string>`${new Date().toISOString()}`.as('createdAt'),
          createdBy: sql<string>`${o.createdBy}`.as('createdBy'),
          fileCount: sql<number>`count(${files.id})`.as('fileCount'),
          totalSize: sql<number>`coalesce(sum(${files.size}), 0)`.as('totalSize'),
        })
        .from(sites)
        .innerJoin(files, eq(files.siteId, sites.id))
        .where(eq(sites.id, o.siteId))
        .groupBy(sites.id),
    ),
    db.insert(siteVersionFiles).select(
      db
        .select({
          versionId: sql<string>`${id}`.as('versionId'),
          path: files.path,
          storageKey: files.storageKey,
          mimeType: files.mimeType,
          size: files.size,
          etag: files.etag,
        })
        .from(files)
        .where(eq(files.siteId, o.siteId)),
    ),
  ] as const
}
