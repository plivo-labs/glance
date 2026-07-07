import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { isSpaceMember } from '../db/repo'
import type { NewFileRow } from '../db/schema'
import { files, sites, spaces } from '../db/schema'
import { fireAndForget } from '../lib/events'
import { isValidSlug } from '../lib/slug'
import { deleteKeys, MAX_FILE_BYTES, sanitizePath } from '../lib/storage'
import { isVisibility, normalizeVisibility } from '../lib/visibility'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// Phase 4: multipart create-or-replace upload. Mounted at /api/upload.
// Accepts a browser cookie OR a CLI Bearer token (both resolved by requireAuth).

const enc = new TextEncoder()

// Hard caps applied BEFORE any R2 write. Each file is one R2 put (a subrequest); an unbounded
// request could exhaust the Workers subrequest budget mid-loop, and the mid-loop cleanup below
// can't reclaim objects when the failure IS exhaustion — so bound the request so it never gets
// there. R2 also rejects object keys over 1024 bytes; catch that up front too, else the reject
// lands only after sibling objects are already committed and orphaned.
const MAX_FILE_COUNT = 200 // one put per file; sized well under the subrequest budget (D1 + deletes need headroom)
const MAX_STORAGE_KEY_BYTES = 1024 // R2's hard object-key limit
const UPLOAD_CONCURRENCY = 10 // bounded parallelism for the R2 put loop

export const upload = new Hono<AppEnv>()

// POST /api/upload/:spaceSlug/:siteSlug — upload a folder of files, creating or replacing the site.
upload.post('/:spaceSlug/:siteSlug', requireAuth, async (c) => {
  // Defensive per-IP rate limit (binding is optional / absent in local dev).
  if (c.env.UPLOAD_LIMITER) {
    const ip = c.req.header('CF-Connecting-IP') ?? 'local'
    const { success } = await c.env.UPLOAD_LIMITER.limit({ key: ip })
    if (!success) return c.json({ error: 'rate limited' }, 429)
  }

  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()

  const form = await c.req.formData()
  const rawVisibility = form.get('visibility')
  // Whether the caller explicitly sent a visibility field. CREATE defaults it to 'team'; REPLACE
  // only touches sites.visibility when it was explicitly provided (else replace keeps the existing
  // tier), so the two cases must stay distinguishable — `|| 'team'` alone can't tell them apart.
  const hasVisibility = typeof rawVisibility === 'string' && rawVisibility !== ''
  const visibility = normalizeVisibility(rawVisibility || 'team')
  const uploaded = form.getAll('files').filter((f): f is File => f instanceof File)

  // Build (path, file) pairs, dropping empty paths; validate per-file size before storing.
  const items: { path: string; file: File }[] = []
  for (const file of uploaded) {
    if (file.size > MAX_FILE_BYTES) return c.json({ error: 'file exceeds 20MB' }, 413)
    const path = sanitizePath(file.name)
    if (!path) continue
    items.push({ path, file })
  }
  if (items.length === 0) return c.json({ error: 'no files' }, 400)
  // Cap the file COUNT before any R2 write — the mid-loop cleanup can't recover from subrequest
  // exhaustion, so this bound is what actually prevents that orphan case.
  if (items.length > MAX_FILE_COUNT) return c.json({ error: 'too many files', max: MAX_FILE_COUNT }, 400)

  // Reject duplicate paths BEFORE any R2 write. Two multipart names can sanitize to the same
  // path (`a/b.html` + `a\b.html`); serving picks one via .limit(1) and the unique(siteId,path)
  // constraint would otherwise 500 the request *after* objects were already committed to R2.
  const seenPaths = new Set<string>()
  for (const { path } of items) {
    if (seenPaths.has(path)) return c.json({ error: 'duplicate path', path }, 400)
    seenPaths.add(path)
  }

  // Resolve space + require membership.
  const space = (
    await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.slug, spaceSlug)).limit(1)
  )[0]
  if (!space) return c.json({ error: 'space not found' }, 404)
  // Superadmin moderates any space (create/replace) — consistent with the owner|superadmin gates on
  // the sites routes (move/delete/visibility/shares). Everyone else must be a member of the space.
  const isAdmin = user.role === 'superadmin'
  if (!isAdmin && !(await isSpaceMember(db, space.id, user.id))) return c.json({ error: 'forbidden' }, 403)

  // Resolve existing site by (spaceId, siteSlug).
  const existing = (
    await db
      .select({ id: sites.id, ownerId: sites.ownerId })
      .from(sites)
      .where(and(eq(sites.spaceId, space.id), eq(sites.slug, siteSlug)))
      .limit(1)
  )[0]

  const replace = c.req.query('replace') === 'true'
  let siteId: string
  let oldKeys: string[] = []
  const isCreate = !existing

  if (!existing) {
    if (!isValidSlug(siteSlug)) return c.json({ error: 'invalid siteSlug' }, 400)
    siteId = crypto.randomUUID()
  } else {
    if (existing.ownerId !== user.id && !isAdmin) return c.json({ error: 'forbidden' }, 403)
    siteId = existing.id
    const existingFiles = await db
      .select({ storageKey: files.storageKey })
      .from(files)
      .where(eq(files.siteId, siteId))
    // Conflict unless the caller explicitly opted into replacing.
    if (existingFiles.length > 0 && !replace) {
      return c.json({ error: 'site exists', conflict: true }, 409)
    }
    oldKeys = existingFiles.map((r) => r.storageKey)
  }

  // Plan every object under a fresh prefix. Build the rows first so the R2 keys are known BEFORE
  // any write — an over-long key is rejected up front (R2 caps keys at 1024 bytes) rather than
  // after sibling objects are already committed and orphaned.
  const prefix = crypto.randomUUID()
  const plan = items.map(({ path, file }) => ({
    file,
    row: {
      id: crypto.randomUUID(),
      siteId,
      path,
      storageKey: `${prefix}/${path}`,
      mimeType: file.type || null,
      size: file.size,
    } satisfies NewFileRow,
  }))
  for (const { row } of plan) {
    if (enc.encode(row.storageKey).byteLength > MAX_STORAGE_KEY_BYTES) {
      return c.json({ error: 'storage key too long', path: row.path }, 400)
    }
  }

  // Write the objects with bounded concurrency so latency doesn't scale linearly with file count.
  // Track every key we attempt: if ANY put throws mid-flight, delete the ones already written so
  // nothing orphans in R2 (there are no rows yet). Deleting a never-written key is a harmless no-op.
  const attempted: string[] = []
  try {
    for (let i = 0; i < plan.length; i += UPLOAD_CONCURRENCY) {
      await Promise.all(
        plan.slice(i, i + UPLOAD_CONCURRENCY).map(({ file, row }) => {
          attempted.push(row.storageKey)
          const contentType = file.type || 'application/octet-stream'
          return c.env.GLANCE_FILES.put(row.storageKey, file.stream(), { httpMetadata: { contentType } })
        }),
      )
    }
  } catch (err) {
    await deleteKeys(c.env.GLANCE_FILES, attempted)
    throw err
  }

  const newRows = plan.map((p) => p.row)
  const insertRows = newRows.map((r) => db.insert(files).values(r))
  const newKeys = newRows.map((r) => r.storageKey)

  try {
    if (isCreate) {
      // CREATE: insert the site row + its file rows in one batch (guaranteed non-empty: items >= 1).
      await db.batch([
        db.insert(sites).values({
          id: siteId,
          spaceId: space.id,
          slug: siteSlug,
          visibility: isVisibility(visibility) ? visibility : 'team',
          ownerId: user.id,
        }),
        ...insertRows,
      ])
    } else {
      // REPLACE: atomically swap file rows (delete old + insert new) in one D1 batch so the serving
      // worker never sees a half-updated site. Update visibility in the SAME batch when the caller
      // explicitly sent one — otherwise a re-upload that picks 'private' would 200 while the site
      // stayed team-visible. Absent → keep the existing tier (replace's long-standing default).
      await db.batch([
        db.delete(files).where(eq(files.siteId, siteId)),
        ...insertRows,
        ...(hasVisibility && isVisibility(visibility)
          ? [db.update(sites).set({ visibility }).where(eq(sites.id, siteId))]
          : []),
      ])
    }
  } catch (err) {
    // D1 write failed (e.g. a concurrent create racing the unique slug) — purge the objects
    // we just uploaded so they don't orphan in R2, then surface the failure.
    await deleteKeys(c.env.GLANCE_FILES, newKeys)
    throw err
  }

  // Old objects are safe to purge only after the row swap committed. Hand it to waitUntil so a
  // transient R2 delete failure can't 500 an already-committed replace — the swap is done;
  // reclaiming the old objects is best-effort background cleanup.
  if (!isCreate && oldKeys.length > 0) await fireAndForget(c, deleteKeys(c.env.GLANCE_FILES, oldKeys))

  return c.json({
    url: `${c.env.APP_URL}/${spaceSlug}/${siteSlug}`,
    siteSlug,
    fileCount: newRows.length,
  })
})
