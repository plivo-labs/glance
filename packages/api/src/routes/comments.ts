import { type Context, Hono } from 'hono'
import { type ElementAnchor, normalizeText, parseElementAnchor } from '../lib/anchor'
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
// Cap on the quote. parseIntent bounds it for iframe-sourced messages, but a direct API call
// bypasses that; without a cap a huge quote bloats the DB and blows up the browser regex the
// annotate client builds from it. The cap is enforced AFTER NFKC folding: a decomposed payload
// (e.g. U+FDFA) expands ~18x once folded, so a raw-length cap would let the stored quote blow far
// past this — normalize first, then measure.
const MAX_QUOTE = 8_000
const MAX_PATH = 1_024

const tooLong = (v: unknown, max: number): boolean => typeof v === 'string' && v.length > max

/** Strip ASCII control chars (C0 range 0x00-0x1F + DEL 0x7F) that would inject raw terminal escape
 *  sequences when the Go CLI prints a comment. Newline + tab survive (legitimate in multi-line
 *  comment text and harmless to a terminal); everything else in the range is dropped at this
 *  untrusted-input boundary. Written without control-char source literals. */
function stripControlChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code === 9 || code === 10 || (code > 31 && code !== 127)) out += ch
  }
  return out
}

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
  // Surface checkAccess's real status so an archived site returns 410 (gone), not a flat 403;
  // `canComment` stays the gate (access.ok ⇒ a non-access refusal would still be 403).
  if (!canComment(row, access)) return c.json({ error: 'forbidden' }, access.ok ? 403 : access.status)
  return row
}

/** Validate a comment body: strip control chars, then require a non-empty string within the cap.
 *  Control chars are stripped BEFORE the cap so it bounds the value we actually store. Null ⇒
 *  caller returns 400. */
function cleanBody(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const body = stripControlChars(v).trim()
  if (!body || body.length > MAX_COMMENT_BODY) return null
  return body
}

// Every route in this router is a comment route, so auth is required on all of them.
comments.use('*', requireAuth)

// GET — list threads (+ ordered comments). With ?filePath, one file's threads; with NO filePath
// at all, the whole site's threads. Authz is site-level (siteOrError), so the site-wide list
// exposes nothing the per-file list didn't.
comments.get('/:space/:site/comments', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const filePath = c.req.query('filePath')
  if (filePath === undefined) return c.json(await listSiteThreads(c.get('db'), site.id))
  if (!filePath || tooLong(filePath, MAX_PATH)) return c.json({ error: 'filePath required' }, 400)
  return c.json(await listThreads(c.get('db'), site.id, filePath))
})

// POST — create a thread + its opening comment. The anchor is stored, not resolved (the client
// paints it against the rendered DOM at view time).
comments.post('/:space/:site/comments', async (c) => {
  const site = await siteOrError(c)
  if (site instanceof Response) return site
  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  if (typeof raw?.filePath !== 'string' || !raw.filePath || tooLong(raw.filePath, MAX_PATH))
    return c.json({ error: 'filePath required' }, 400)
  // Fold (NFKC) + strip control chars BEFORE the cap so it bounds the value we actually store —
  // a decomposed payload can expand ~18x under NFKC, past a raw-length cap. This is the same
  // normalizer createThread applies, so the check measures the stored quote exactly.
  const quote = typeof raw.quote === 'string' ? normalizeText(stripControlChars(raw.quote)) : undefined
  if (quote !== undefined && quote.length > MAX_QUOTE) return c.json({ error: 'quote too long' }, 400)
  const anchorType = raw.anchorType === 'page' ? 'page' : raw.anchorType === 'element' ? 'element' : 'text'

  // An element anchor is validated + built in the canonical layer; the route only maps its error to
  // a 400 (element without a selector must NOT silently coerce to text).
  let anchor: ElementAnchor | undefined
  if (anchorType === 'element') {
    const parsed = parseElementAnchor(raw.element)
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    anchor = parsed.anchor
  }

  const out = await createThread(c.get('db'), {
    siteId: site.id,
    filePath: raw.filePath,
    createdBy: c.get('user').id,
    body,
    anchorType,
    quote,
    anchor,
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
  // An already soft-deleted comment is gone: editing / re-deleting it is a silent no-op that could
  // resurface a redacted thread, so treat it as not found.
  if (comment.deletedAt !== null) return c.json({ error: 'not found' }, 404)
  const thread = await getThread(c.get('db'), comment.threadId)
  if (!thread || thread.siteId !== siteId) return c.json({ error: 'not found' }, 404)
  return comment
}
