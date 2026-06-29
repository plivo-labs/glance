import { type Context, Hono } from 'hono'
import {
  addComment,
  createThread,
  deleteComment,
  editComment,
  getComment,
  getThread,
  listSiteThreads,
  listThreads,
  reopenThread,
  resolveThread,
} from '../db/comments'
import type { ResolvedSite } from '../lib/site-access'
import { resolveSiteForAccess } from '../lib/site-access'
import { requireAuth } from '../middleware/auth'
import type { AppEnv, SessionUser } from '../types'

// Comments API. Mounted at /api/sites, so paths are /:space/:site/comments… — three segments,
// so they never collide with the two-segment site routes. CSRF (requireSameOrigin) and withDb
// are already global on /api/* in index.ts; do NOT re-add them here.

const MAX_COMMENT_BODY = 10_000
// Caps on the anchor fields. parseIntent bounds these for iframe-sourced messages, but a direct
// API call bypasses it; without a cap a huge quote bloats the DB and blows up the browser regex
// the annotate client builds from it. prefix/suffix are sliced to 64 by buildAnchor, but cap the
// raw input too so we never NFKC-fold a multi-MB string just to throw it away.
const MAX_QUOTE = 8_000
const MAX_PATH = 1_024

const tooLong = (v: unknown, max: number): boolean => typeof v === 'string' && v.length > max

export const comments = new Hono<AppEnv>()

// Pure gate: comments are allowed wherever the viewer has access. Every tier is now authed (the
// public/anonymous tier was removed), so access-ok is the whole gate. Reached only after
// requireAuth, so `user` is guaranteed.
function canComment(_site: ResolvedSite, access: { ok: boolean }): boolean {
  return access.ok
}

// Site owner or superadmin may resolve/reopen any thread and delete any comment.
const canModerate = (site: ResolvedSite, user: SessionUser): boolean =>
  site.ownerId === user.id || user.role === 'superadmin'

/** Resolve the site, run the shared access check, and enforce `canComment`. Returns the site
 *  or a Response the caller should return as-is. */
async function siteOrError(c: Context<AppEnv>): Promise<ResolvedSite | Response> {
  const user = c.get('user')
  const { space, site } = c.req.param()
  const { site: row, access } = await resolveSiteForAccess(c.get('db'), space, site, user)
  if (!row) return c.json({ error: 'not found' }, 404)
  if (!canComment(row, access)) return c.json({ error: 'forbidden' }, 403)
  return row
}

/** Validate a comment body: non-empty string within the cap. Null ⇒ caller returns 400. */
function cleanBody(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const body = v.trim()
  if (!body || body.length > MAX_COMMENT_BODY) return null
  return body
}

// Every route in this router is a comment route, so auth is required on all of them.
comments.use('*', requireAuth)

// GET — list threads (+ reconciled anchors + ordered comments). With ?filePath, one file's
// threads (as before); with NO filePath at all, the whole site's threads. Authz is site-level
// (siteOrError), so the site-wide list exposes nothing the per-file list didn't.
comments.get('/:space/:site/comments', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const filePath = c.req.query('filePath')
  if (filePath === undefined) return c.json(await listSiteThreads(c.get('db'), c.env.GLANCE_FILES, site.id))
  if (!filePath || tooLong(filePath, MAX_PATH)) return c.json({ error: 'filePath required' }, 400)
  return c.json(await listThreads(c.get('db'), c.env.GLANCE_FILES, site.id, filePath))
})

// POST — create a thread + its opening comment (anchor resolved server-side).
comments.post('/:space/:site/comments', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  if (typeof raw?.filePath !== 'string' || !raw.filePath || tooLong(raw.filePath, MAX_PATH))
    return c.json({ error: 'filePath required' }, 400)
  if ([raw.quote, raw.prefix, raw.suffix].some((v) => tooLong(v, MAX_QUOTE)))
    return c.json({ error: 'anchor too long' }, 400)
  const anchorType = raw.anchorType === 'page' ? 'page' : 'text'
  const out = await createThread(c.get('db'), c.env.GLANCE_FILES, {
    siteId: site.id,
    filePath: raw.filePath,
    createdBy: c.get('user').id,
    body,
    anchorType,
    quote: typeof raw.quote === 'string' ? raw.quote : undefined,
    prefix: typeof raw.prefix === 'string' ? raw.prefix : undefined,
    suffix: typeof raw.suffix === 'string' ? raw.suffix : undefined,
  })
  return c.json(out, 201)
})

// POST — flat reply to a thread.
comments.post('/:space/:site/comments/:threadId/replies', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const thread = await getThread(c.get('db'), c.req.param('threadId'))
  if (!thread || thread.siteId !== site.id) return c.json({ error: 'not found' }, 404)
  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const id = await addComment(c.get('db'), { threadId: thread.id, authorId: c.get('user').id, body })
  return c.json({ id }, 201)
})

// PATCH — resolve / reopen a thread (owner or superadmin only).
comments.patch('/:space/:site/comments/:threadId', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const user = c.get('user')
  if (!canModerate(site, user)) return c.json({ error: 'forbidden' }, 403)
  const thread = await getThread(c.get('db'), c.req.param('threadId'))
  if (!thread || thread.siteId !== site.id) return c.json({ error: 'not found' }, 404)
  const raw = await c.req.json().catch(() => null)
  if (raw?.status === 'resolved') await resolveThread(c.get('db'), thread.id, user.id)
  else if (raw?.status === 'open') await reopenThread(c.get('db'), thread.id)
  else return c.json({ error: 'invalid status' }, 400)
  return c.json({ ok: true })
})

// PATCH — edit a comment (author only).
comments.patch('/:space/:site/comments/:threadId/messages/:commentId', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const comment = await commentInSite(c, site.id)
  if (comment instanceof Response) return comment
  if (comment.authorId !== c.get('user').id) return c.json({ error: 'forbidden' }, 403)
  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  await editComment(c.get('db'), comment.threadId, comment.id, body)
  return c.json({ ok: true })
})

// DELETE — soft-delete a comment (author, or owner/superadmin).
comments.delete('/:space/:site/comments/:threadId/messages/:commentId', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const user = c.get('user')
  const comment = await commentInSite(c, site.id)
  if (comment instanceof Response) return comment
  if (comment.authorId !== user.id && !canModerate(site, user)) return c.json({ error: 'forbidden' }, 403)
  await deleteComment(c.get('db'), comment.threadId, comment.id)
  return c.json({ ok: true })
})

/** Load the path's comment and confirm it belongs to this site's thread. 404 otherwise. */
async function commentInSite(c: Context<AppEnv>, siteId: string) {
  const { threadId, commentId } = c.req.param()
  const comment = await getComment(c.get('db'), commentId)
  if (!comment || comment.threadId !== threadId) return c.json({ error: 'not found' }, 404)
  const thread = await getThread(c.get('db'), comment.threadId)
  if (!thread || thread.siteId !== siteId) return c.json({ error: 'not found' }, 404)
  return comment
}
