import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { isSpaceMember } from '../db/repo'
import type { NewFileRow, Visibility } from '../db/schema'
import { files, sites, spaces } from '../db/schema'
import { hashContent } from '../lib/anchor'
import { isValidSlug } from '../lib/slug'
import { deleteKeys, MAX_FILE_BYTES, sanitizePath } from '../lib/storage'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// Phase 4: multipart create-or-replace upload. Mounted at /api/upload.
// Accepts a browser cookie OR a CLI Bearer token (both resolved by requireAuth).

const VISIBILITIES: ReadonlySet<string> = new Set(['private', 'group', 'team', 'public'])
const isVisibility = (v: unknown): v is Visibility => typeof v === 'string' && VISIBILITIES.has(v)

// HTML is the only anchorable type (v1 anchors over static HTML source text), so it's the only
// type we read-and-hash at upload; everything else streams straight through with a null hash.
const isHtmlUpload = (path: string, mime: string): boolean =>
  /\.(html?|xhtml)$/i.test(path) || mime === 'text/html'

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
  const visibility = (form.get('visibility') as string) || 'team'
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
  if (!(await isSpaceMember(db, space.id, user.id))) return c.json({ error: 'forbidden' }, 403)

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
    if (existing.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)
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

  // Upload every file under a fresh prefix; collect the new file rows.
  const prefix = crypto.randomUUID()
  const newRows: NewFileRow[] = []
  for (const { path, file } of items) {
    const storageKey = `${prefix}/${path}`
    const contentType = file.type || 'application/octet-stream'
    // HTML: read the body once, store contentHash for the re-anchor gate, and put the text we
    // already read (no double read). Everything else streams straight to R2 with a null hash.
    let contentHash: string | null = null
    if (isHtmlUpload(path, file.type)) {
      const text = await file.text()
      contentHash = await hashContent(text)
      await c.env.GLANCE_FILES.put(storageKey, text, { httpMetadata: { contentType } })
    } else {
      await c.env.GLANCE_FILES.put(storageKey, file.stream(), { httpMetadata: { contentType } })
    }
    newRows.push({
      id: crypto.randomUUID(),
      siteId,
      path,
      storageKey,
      mimeType: file.type || null,
      size: file.size,
      contentHash,
    })
  }

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
      // REPLACE: atomically swap file rows (delete old + insert new) in one D1 batch so the
      // serving worker never sees a half-updated site.
      await db.batch([db.delete(files).where(eq(files.siteId, siteId)), ...insertRows])
    }
  } catch (err) {
    // D1 write failed (e.g. a concurrent create racing the unique slug) — purge the objects
    // we just uploaded so they don't orphan in R2, then surface the failure.
    await deleteKeys(c.env.GLANCE_FILES, newKeys)
    throw err
  }

  // Old objects are safe to purge only after the row swap committed.
  if (!isCreate) await deleteKeys(c.env.GLANCE_FILES, oldKeys)

  return c.json({
    url: `${c.env.APP_URL}/${spaceSlug}/${siteSlug}`,
    siteSlug,
    fileCount: newRows.length,
  })
})
