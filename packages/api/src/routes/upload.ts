import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { isSpaceMember, resolveShareRole } from '../db/repo'
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
  // Optional display title, applied on CREATE only (REPLACE keeps whatever the site already has —
  // a re-upload/record must never silently rename an existing site). Trimmed + capped; empty → null.
  const rawTitle = form.get('title')
  const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 200) || null : null
  // Optimistic-concurrency token for a REPLACE: the contentVersion the caller last pulled. REQUIRED
  // for an editor replace (CAS below), advisory/ignored for an owner. Parsed to a non-negative int or
  // null (absent/blank/non-numeric).
  const rawExpected = form.get('expectedVersion')
  const expectedVersion =
    typeof rawExpected === 'string' && rawExpected.trim() !== '' && Number.isInteger(Number(rawExpected))
      ? Number(rawExpected)
      : null
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

  // Resolve space.
  const space = (
    await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.slug, spaceSlug)).limit(1)
  )[0]
  if (!space) return c.json({ error: 'space not found' }, 404)
  const isAdmin = user.role === 'superadmin'

  // Resolve the existing site (if any) BEFORE authorizing — CREATE and REPLACE have DIFFERENT gates:
  // creating needs space membership; replacing is open to the owner, a superadmin, or a direct EDITOR
  // grantee (who is typically NOT a space member, so the old membership-first gate 403'd them). Load
  // contentVersion + status too: the editor CAS + archived guard need them.
  const existing = (
    await db
      .select({ id: sites.id, ownerId: sites.ownerId, contentVersion: sites.contentVersion, status: sites.status })
      .from(sites)
      .where(and(eq(sites.spaceId, space.id), eq(sites.slug, siteSlug)))
      .limit(1)
  )[0]

  const replace = c.req.query('replace') === 'true'
  const isCreate = !existing
  let siteId: string
  let oldKeys: string[] = []
  // True when the actor is exercising an EDITOR grant (not the owner, not a superadmin). Editors are
  // content-only: no visibility change, no archived-site edit, and every replace is version-CAS'd.
  let actingAsEditor = false

  if (!existing) {
    // CREATE: space member or superadmin only. An editor grant confers no create right.
    if (!isAdmin && !(await isSpaceMember(db, space.id, user.id))) return c.json({ error: 'forbidden' }, 403)
    if (!isValidSlug(siteSlug)) return c.json({ error: 'invalid siteSlug' }, 400)
    siteId = crypto.randomUUID()
  } else {
    // REPLACE: owner, superadmin, or a direct editor share.
    const isOwner = existing.ownerId === user.id
    actingAsEditor = !isOwner && !isAdmin && (await resolveShareRole(db, existing.id, user.id)) === 'editor'
    if (!isOwner && !isAdmin && !actingAsEditor) return c.json({ error: 'forbidden' }, 403)

    if (actingAsEditor) {
      if (existing.status === 'archived') return c.json({ error: 'site archived' }, 403)
      // The CAS below reads expectedVersion; require it up front so a versionless editor redeploy
      // can't silently clobber a newer one.
      if (expectedVersion === null) return c.json({ error: 'expectedVersion required' }, 400)
    }

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
  // The revision this upload publishes: CREATE starts at 0; every REPLACE bumps by one (advisory for
  // owner/superadmin, CAS-enforced for an editor).
  const newVersion = existing ? existing.contentVersion + 1 : 0

  try {
    if (isCreate) {
      // CREATE: insert the site row + its file rows in one batch (guaranteed non-empty: items >= 1).
      await db.batch([
        db.insert(sites).values({
          id: siteId,
          spaceId: space.id,
          slug: siteSlug,
          title,
          visibility: isVisibility(visibility) ? visibility : 'team',
          ownerId: user.id,
        }),
        ...insertRows,
      ])
    } else if (actingAsEditor) {
      // EDITOR REPLACE — CAS: atomically claim the revision via a conditional bump. A stale
      // expectedVersion changes 0 rows (returning() is empty), so we 409 with the files left
      // completely untouched (nothing swapped; the just-written R2 objects reclaimed). No TOCTOU
      // read-compare-write, and no visibility change — an editor edits content only. On success the
      // version is already bumped + lastReplacedBy recorded, so the swap batch only moves file rows.
      // (The bump and swap are two statements: if the swap throws after a winning CAS, the version is
      // ahead of the content until the next replace re-syncs it — a rare, self-healing window, and the
      // price of leaving files untouched on a stale 409, which a single atomic batch cannot express.)
      const claimed = await db
        .update(sites)
        .set({ contentVersion: sql`${sites.contentVersion} + 1`, lastReplacedBy: user.id })
        .where(and(eq(sites.id, siteId), eq(sites.contentVersion, expectedVersion as number)))
        .returning({ id: sites.id })
      if (claimed.length === 0) {
        await deleteKeys(c.env.GLANCE_FILES, newKeys)
        return c.json({ error: 'version conflict', conflict: true }, 409)
      }
      await db.batch([db.delete(files).where(eq(files.siteId, siteId)), ...insertRows])
    } else {
      // OWNER / SUPERADMIN REPLACE: atomically swap file rows, bump the version advisorily + record
      // lastReplacedBy, and apply visibility only when the caller explicitly sent one (absent → keep
      // the existing tier — replace's long-standing default). One D1 batch so the serving worker
      // never sees a half-updated site.
      await db.batch([
        db.delete(files).where(eq(files.siteId, siteId)),
        ...insertRows,
        db
          .update(sites)
          .set({
            contentVersion: sql`${sites.contentVersion} + 1`,
            lastReplacedBy: user.id,
            ...(hasVisibility && isVisibility(visibility) ? { visibility } : {}),
          })
          .where(eq(sites.id, siteId)),
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
    contentVersion: newVersion,
  })
})
