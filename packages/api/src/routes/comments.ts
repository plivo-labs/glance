import { type Context, Hono } from 'hono'
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import { type ElementAnchor, normalizeText, parseElementAnchor } from '../lib/anchor'
import {
  addComment,
  assembleThreadViews,
  commentByIdStmt,
  commentsWithAuthorsBySlugsStmt,
  createThread,
  deleteComment,
  editComment,
  reopenThread,
  resolveThread,
  threadByIdStmt,
  threadOfCommentStmt,
  threadsWithUsersBySlugsStmt,
} from '../db/comments'
import { truncateSnippet } from '../db/comment-feed'
import { createNotifications, type NotificationInput, resolveCommentAudience } from '../db/notifications'
import type { Comment, CommentThread } from '../db/schema'
import { listMentionableUsers } from '../db/repo'
import { fireAndForget } from '../lib/events'
import { EXT_MIME, audioExtFromPart, contentType } from '../lib/mime'
import type { AccessFacts, ResolvedSite } from '../lib/site-access'
import { fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { decideRange } from '../lib/range'
import { deleteKeys } from '../lib/storage'
import { transcribeVoice } from '../lib/transcribe'
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
// Voice comments: cap the uploaded recording and the fallback body used when transcription is
// unavailable. A voice comment must never be lost to an AI outage — see lib/transcribe.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const VOICE_FALLBACK_BODY = '[voice message]'

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

/** PURE post-batch gate on assembled access facts: missing site → 404, then `checkAccess` (the
 *  live session user from requireAuth is the subject, exactly as before) with `canComment` as
 *  the gate. Surfaces checkAccess's real status so an archived site returns 410 (gone), not a
 *  flat 403 (access.ok ⇒ a non-access refusal would still be 403). Evaluated AFTER the facts
 *  batch resolves — a route that fuses extra statements into that batch (S9b) must return this
 *  denial WITHOUT touching their rows. Returns the site or a Response to return as-is. */
function siteFromFacts(c: Context<AppEnv>, facts: AccessFacts): ResolvedSite | Response {
  const { site, access } = siteAccessFromFacts(facts, c.get('user'))
  if (!site) return c.json({ error: 'not found' }, 404)
  if (!canComment(site, access)) return c.json({ error: 'forbidden' }, access.ok ? 403 : access.status)
  return site
}

/** THE route-level gate: params → the access facts (S9a: one slug-keyed db.batch where the old
 *  resolveSiteForAccess did the same reads in three round trips) plus any caller-fused extra
 *  statements riding that SAME batch (S9b/S9c) → siteFromFacts. requireAuth's own loose user
 *  read stays — a parked policy (audit F7) — so every comments endpoint is 2+ D1 requests
 *  minimum. Returns the denial Response to return as-is, or the site plus the extras' typed row
 *  arrays (untouched by the gate — each route orders its own post-checks). */
async function gated<T extends readonly BatchItem<'sqlite'>[]>(
  c: Context<AppEnv>,
  ...extras: [...T]
): Promise<{ site: ResolvedSite; extras: BatchResponse<T> } | Response> {
  const { space, site: siteSlug } = c.req.param()
  const { facts, extras: rows } = await fetchAccessFacts(c.get('db'), space, siteSlug, c.get('user').id, ...extras)
  const site = siteFromFacts(c, facts)
  if (site instanceof Response) return site
  return { site, extras: rows }
}

/** The thread-in-site relationship gate shared by every thread-targeted route: an absent row and
 *  a thread from ANOTHER site get the same opaque 404 (never leak cross-site existence). */
const threadInSite = (thread: CommentThread | undefined, siteId: string): thread is CommentThread =>
  thread !== undefined && thread.siteId === siteId

/** S9c: ONE pre-write batch for a thread-targeted mutation — the 5 access facts PLUS the URL's
 *  thread row (id-keyed from the path, so known pre-batch; non-failing). Access is gated here
 *  (siteFromFacts precedence unchanged); the thread row comes back UNCHECKED because the routes
 *  order their remaining checks differently (resolve/reopen put the role 403 BEFORE the thread
 *  404 — pinned by comments.test.ts's member-cannot-resolve spec). */
async function siteWithUrlThread(
  c: Context<AppEnv>,
): Promise<{ site: ResolvedSite; thread: CommentThread | undefined } | Response> {
  const { threadId } = c.req.param()
  const gate = await gated(c, threadByIdStmt(c.get('db'), threadId))
  if (gate instanceof Response) return gate
  return { site: gate.site, thread: gate.extras[0][0] }
}

/** S9c replacement for the old serial commentInSite: ONE pre-write batch — access facts + the
 *  URL's comment AND thread rows (both ids are in the path, so both reads are known pre-batch).
 *  Check order preserved exactly: access → comment-missing / threadId-mismatch 404 → deleted 404
 *  → thread-in-site 404. The threadId ≠ comment.threadId check stays a post-batch comparison
 *  (T9.4), which also makes the thread-by-URL-id read equivalent to the old thread-by-
 *  comment.threadId read: past the mismatch check the two ids are equal. */
async function siteWithUrlComment(c: Context<AppEnv>): Promise<{ site: ResolvedSite; comment: Comment } | Response> {
  const db = c.get('db')
  const { threadId, commentId } = c.req.param()
  const gate = await gated(c, commentByIdStmt(db, commentId), threadByIdStmt(db, threadId))
  if (gate instanceof Response) return gate
  const { site, extras } = gate
  const comment = extras[0][0]
  if (!comment || comment.threadId !== threadId) return c.json({ error: 'not found' }, 404)
  // An already soft-deleted comment is gone: editing / re-deleting it is a silent no-op that could
  // resurface a redacted thread, so treat it as not found.
  if (comment.deletedAt !== null) return c.json({ error: 'not found' }, 404)
  if (!threadInSite(extras[1][0], site.id)) return c.json({ error: 'not found' }, 404)
  return { site, comment }
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

/** Raise mention + comment-audience notifications for a just-written comment. Explicit
 *  mentions are deduped, self-skipped, and intersected against the autocomplete's access set.
 *  The comment audience is the owner + direct shares + (for replies) prior participants, then
 *  re-authorized from targeted membership/group-share facts; mentions win over comment rows.
 *  Every recipient is inserted in one bind-safe batch. Fully guarded and fire-and-forget: notification
 *  reads or writes must NEVER fail or block the comment that already committed. */
async function notifyForComment(
  c: Context<AppEnv>,
  site: ResolvedSite,
  opts: {
    rawMentions: unknown
    threadId: string
    commentId: string
    filePath: string
    snippet: string
    isReply: boolean
  },
): Promise<void> {
  const callerId = c.get('user').id
  const db = c.get('db')
  const { space, site: siteSlug } = c.req.param()
  const siteLabel = `${space}/${siteSlug}`
  await fireAndForget(
    c,
    (async () => {
      try {
        const requested = Array.isArray(opts.rawMentions)
          ? [...new Set(opts.rawMentions.filter((m): m is string => typeof m === 'string' && m !== callerId))]
          : []
        let mentionRecipients: string[] = []
        if (requested.length > 0) {
          const allowed = new Set((await listMentionableUsers(db, site, callerId)).map((u) => u.id))
          mentionRecipients = requested.filter((id) => allowed.has(id))
        }

        const commentRecipients = await resolveCommentAudience(db, site, {
          threadId: opts.threadId,
          isReply: opts.isReply,
          exclude: new Set([callerId, ...mentionRecipients]),
        })
        if (mentionRecipients.length === 0 && commentRecipients.length === 0) return

        const snippet = truncateSnippet(opts.snippet)
        const toRow = (recipientId: string, type: NotificationInput['type']): NotificationInput => ({
          recipientId,
          type,
          actorId: callerId,
          siteId: site.id,
          siteLabel,
          threadId: opts.threadId,
          commentId: opts.commentId,
          filePath: opts.filePath,
          snippet,
        })
        await createNotifications(db, [
          ...mentionRecipients.map((id) => toRow(id, 'mention')),
          ...commentRecipients.map((id) => toRow(id, 'comment')),
        ])
      } catch {
        // Notifications are best-effort — never surface to the caller (mirrors recordEvent).
      }
    })(),
  )
}

function notifyThreadCreated(
  c: Context<AppEnv>,
  site: ResolvedSite,
  opts: {
    out: Pick<Awaited<ReturnType<typeof createThread>>, 'threadId' | 'openingCommentId'>
    filePath: string
    snippet: string
    rawMentions?: unknown
  },
): Promise<void> {
  return notifyForComment(c, site, {
    rawMentions: opts.rawMentions,
    threadId: opts.out.threadId,
    commentId: opts.out.openingCommentId,
    filePath: opts.filePath,
    snippet: opts.snippet,
    isReply: false,
  })
}

function notifyReply(
  c: Context<AppEnv>,
  site: ResolvedSite,
  opts: {
    thread: Pick<CommentThread, 'id' | 'filePath'>
    commentId: string
    snippet: string
    rawMentions?: unknown
  },
): Promise<void> {
  return notifyForComment(c, site, {
    rawMentions: opts.rawMentions,
    threadId: opts.thread.id,
    commentId: opts.commentId,
    filePath: opts.thread.filePath,
    snippet: opts.snippet,
    isReply: true,
  })
}

type ThreadFields = {
  filePath: string
  quote: string | undefined
  anchorType: 'text' | 'page' | 'element'
  anchor: ElementAnchor | undefined
}

/** Validate the anchor-shaping fields shared by the JSON and multipart create paths: filePath
 *  (required, capped), quote (folded + control-stripped + capped), anchorType, and — for an element
 *  anchor — the parsed+validated element payload. Returns an error+status to return as-is, or the
 *  normalized fields. `element` must already be a PARSED object (parseElementAnchor expects one). */
function parseThreadFields(raw: {
  filePath?: unknown
  quote?: unknown
  anchorType?: unknown
  element?: unknown
}): { error: string } | ThreadFields {
  if (typeof raw.filePath !== 'string' || !raw.filePath || tooLong(raw.filePath, MAX_PATH))
    return { error: 'filePath required' }
  // Fold (NFKC) + strip control chars BEFORE the cap so it bounds the value we actually store —
  // a decomposed payload can expand ~18x under NFKC, past a raw-length cap. This is the same
  // normalizer createThread applies, so the check measures the stored quote exactly.
  const quote = typeof raw.quote === 'string' ? normalizeText(stripControlChars(raw.quote)) : undefined
  if (quote !== undefined && quote.length > MAX_QUOTE) return { error: 'quote too long' }
  const anchorType = raw.anchorType === 'page' ? 'page' : raw.anchorType === 'element' ? 'element' : 'text'

  // An element anchor is validated + built in the canonical layer; the route only maps its error to
  // a 400 (element without a selector must NOT silently coerce to text).
  let anchor: ElementAnchor | undefined
  if (anchorType === 'element') {
    const parsed = parseElementAnchor(raw.element)
    if ('error' in parsed) return { error: parsed.error }
    anchor = parsed.anchor
  }
  return { filePath: raw.filePath, quote, anchorType, anchor }
}

/** Shared voice-comment ingest for create + reply. Validate the `audio` part, cap its size (no R2
 *  put / D1 write for an oversize or empty part), pre-generate the comment id so it can name the R2
 *  object BEFORE the D1 insert, transcribe best-effort (any failure → fallback body, audio still
 *  kept), then store the audio in R2. Returns the pieces the caller writes to D1, or a Response to
 *  return as-is. Callers still own the D1 write + its R2 compensation. */
async function ingestVoiceComment(
  c: Context<AppEnv>,
  form: FormData,
): Promise<{ commentId: string; audioKey: string; body: string } | Response> {
  const part = form.get('audio')
  if (!(part instanceof File)) return c.json({ error: 'audio required' }, 400)
  const ext = audioExtFromPart(part.name, part.type)
  if (!ext) return c.json({ error: 'unsupported audio type' }, 400)
  // Reject oversize by declared size BEFORE buffering the part into memory (a 100MB part shouldn't
  // be read just to be rejected). Empty is caught after read (size can under-report a 0-byte part).
  if (part.size > MAX_AUDIO_BYTES) return c.json({ error: 'audio too large' }, 413)
  const bytes = new Uint8Array(await part.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'audio required' }, 400)
  if (bytes.byteLength > MAX_AUDIO_BYTES) return c.json({ error: 'audio too large' }, 413)

  const commentId = crypto.randomUUID()
  const audioKey = `comment-audio/${commentId}.${ext}`
  // Transcription (a Workers-AI round trip) and the R2 put both need only `bytes` and neither
  // depends on the other — run them together so the AI latency doesn't stack on the upload latency.
  const [transcript] = await Promise.all([
    transcribeVoice(c.env.AI, bytes),
    c.env.GLANCE_FILES.put(audioKey, bytes, { httpMetadata: { contentType: EXT_MIME[ext] } }),
  ])
  // Best-effort transcript is the stored body so the CLI/agent review loop reads it as text. The
  // transcript is server-generated, so it skips cleanBody's empty-reject; still strip control chars
  // (a CLI prints the body) + truncate at the cap, and fall back so the body is never empty.
  const cleaned = transcript ? stripControlChars(transcript).trim().slice(0, MAX_COMMENT_BODY) : ''
  const body = cleaned || VOICE_FALLBACK_BODY
  return { commentId, audioKey, body }
}

/** True when the request carries a multipart/form-data body (the voice-comment branch). */
const isMultipart = (c: Context<AppEnv>): boolean =>
  (c.req.header('content-type') ?? '').startsWith('multipart/form-data')

// Every route in this router is a comment route, so auth is required on all of them.
comments.use('*', requireAuth)

// GET — list threads (+ ordered comments). With ?filePath, one file's threads; with NO filePath
// at all, the whole site's threads. Authz is site-level (siteFromFacts), so the site-wide list
// exposes nothing the per-file list didn't.
//
// S9b: ONE fused db.batch — the 5 slug-keyed access facts PLUS the two S8 list statements (also
// slug-keyed: the site id is unknown pre-batch). Every statement is a non-failing SELECT, so the
// gate is EVALUATED AFTER the batch in today's precedence: 404/403/410 first — a denial returns
// without ever touching the already-fetched list rows (accepted design) — then the filePath 400
// (an invalid filePath was batched too; it just matches no rows, which the 400 discards).
comments.get('/:space/:site/comments', async (c) => {
  const db = c.get('db')
  const { space, site: siteSlug } = c.req.param()
  const filePath = c.req.query('filePath')
  const gate = await gated(
    c,
    threadsWithUsersBySlugsStmt(db, space, siteSlug, filePath),
    commentsWithAuthorsBySlugsStmt(db, space, siteSlug, filePath),
  )
  if (gate instanceof Response) return gate
  if (filePath !== undefined && (!filePath || tooLong(filePath, MAX_PATH)))
    return c.json({ error: 'filePath required' }, 400)
  const [threadRows, commentRows] = gate.extras
  return c.json(assembleThreadViews(threadRows, commentRows))
})

// GET — who the caller may @-mention on this site (autocomplete source). Same access gate as
// commenting, then the visibility-branched mentionable set minus the caller.
comments.get('/:space/:site/mentionable', async (c) => {
  const gate = await gated(c)
  if (gate instanceof Response) return gate
  return c.json(await listMentionableUsers(c.get('db'), gate.site, c.get('user').id))
})

// GET — stream a voice comment's audio. S9c: the access facts, the comment, and its thread
// (reached THROUGH the comment — there's no threadId in this path, so the join walks the
// relationship inside the statement) resolve in ONE batch; the whole pre-R2 D1 bill is that
// batch + requireAuth's loose read. Gate precedence unchanged: access → comment (a text or
// soft-deleted comment 404s — audioKey nulled) → thread-in-site. The object is small (≤10MB),
// so we do one unranged R2 get and slice in memory for a Range request.
comments.get('/:space/:site/comments/audio/:commentId', async (c) => {
  const db = c.get('db')
  const commentId = c.req.param('commentId')
  const gate = await gated(c, commentByIdStmt(db, commentId), threadOfCommentStmt(db, commentId))
  if (gate instanceof Response) return gate
  const { site, extras } = gate
  const comment = extras[0][0]
  if (!comment || comment.deletedAt !== null || !comment.audioKey) return c.json({ error: 'not found' }, 404)
  if (!threadInSite(extras[1][0]?.thread, site.id)) return c.json({ error: 'not found' }, 404)
  const object = await c.env.GLANCE_FILES.get(comment.audioKey)
  if (!object) return c.json({ error: 'not found' }, 404)

  const headers = new Headers({
    'content-type': contentType(comment.audioKey, object.httpMetadata?.contentType ?? null),
    etag: object.httpEtag,
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-cache',
  })
  // A matching If-None-Match short-circuits before Range (RFC 7233 §3.1).
  if (c.req.header('if-none-match') === object.httpEtag) return new Response(null, { status: 304, headers })

  const bytes = new Uint8Array(await object.arrayBuffer())
  const total = object.size ?? bytes.byteLength
  const decision = decideRange(c.req.header('range'), total, headers)
  if (decision.status === 416) return new Response(null, { status: 416, headers })
  if (decision.status === 206) {
    return new Response(bytes.subarray(decision.start, decision.end + 1), { status: 206, headers })
  }
  return new Response(bytes, { headers })
})

// POST — create a thread + its opening comment. The anchor is stored, not resolved (the client
// paints it against the rendered DOM at view time).
comments.post('/:space/:site/comments', async (c) => {
  const gate = await gated(c)
  if (gate instanceof Response) return gate
  const { site } = gate
  if (isMultipart(c)) return createVoiceThread(c, site)

  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const fields = parseThreadFields(raw ?? {})
  if ('error' in fields) return c.json({ error: fields.error }, 400)

  const out = await createThread(c.get('db'), {
    siteId: site.id,
    filePath: fields.filePath,
    createdBy: c.get('user').id,
    body,
    anchorType: fields.anchorType,
    quote: fields.quote,
    anchor: fields.anchor,
  })
  await notifyThreadCreated(c, site, { out, filePath: fields.filePath, snippet: body, rawMentions: raw?.mentions })
  return c.json(out, 201)
})

/** Multipart (voice) create: shape the anchor fields from the FormData (element arrives as a JSON
 *  string), ingest the audio, then write the thread — compensating the R2 object if the D1 write
 *  fails so a failed create never orphans the recording. Pure validation runs BEFORE the R2 put so
 *  a rejected request never leaves an object behind either. */
async function createVoiceThread(c: Context<AppEnv>, site: ResolvedSite): Promise<Response> {
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'invalid form' }, 400)

  // `element` arrives as a JSON string; parse it here (parseElementAnchor expects a parsed object).
  let element: unknown
  const rawElement = form.get('element')
  if (typeof rawElement === 'string' && rawElement) {
    try {
      element = JSON.parse(rawElement)
    } catch {
      return c.json({ error: 'invalid element' }, 400)
    }
  }
  const fields = parseThreadFields({
    filePath: form.get('filePath'),
    quote: form.get('quote'),
    anchorType: form.get('anchorType'),
    element,
  })
  if ('error' in fields) return c.json({ error: fields.error }, 400)

  const ingested = await ingestVoiceComment(c, form)
  if (ingested instanceof Response) return ingested
  const { commentId, audioKey, body } = ingested
  let out: Awaited<ReturnType<typeof createThread>>
  try {
    out = await createThread(c.get('db'), {
      siteId: site.id,
      filePath: fields.filePath,
      createdBy: c.get('user').id,
      body,
      anchorType: fields.anchorType,
      quote: fields.quote,
      anchor: fields.anchor,
      commentId,
      audioKey,
    })
  } catch (e) {
    await deleteKeys(c.env.GLANCE_FILES, [audioKey]) // compensation: don't orphan the R2 object
    throw e
  }
  await notifyThreadCreated(c, site, { out, filePath: fields.filePath, snippet: body })
  return c.json(out, 201)
}

// POST — flat reply to a thread. S9c: the thread read rides the access batch (siteWithUrlThread),
// so the whole pre-write D1 bill is one batch + requireAuth's loose read.
comments.post('/:space/:site/comments/:threadId/replies', async (c) => {
  const gate = await siteWithUrlThread(c)
  if (gate instanceof Response) return gate
  const { site, thread } = gate
  if (!threadInSite(thread, site.id)) return c.json({ error: 'not found' }, 404)
  if (isMultipart(c)) return replyVoiceComment(c, site, thread)

  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const id = await addComment(c.get('db'), { threadId: thread.id, authorId: c.get('user').id, body })
  await notifyReply(c, site, { thread, commentId: id, snippet: body, rawMentions: raw?.mentions })
  return c.json({ id }, 201)
})

/** Multipart (voice) reply: ingest the audio (transcript is the whole body — a reply has no anchor
 *  fields), then append the comment, compensating the R2 object if the D1 write fails. */
async function replyVoiceComment(c: Context<AppEnv>, site: ResolvedSite, thread: CommentThread): Promise<Response> {
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'invalid form' }, 400)
  const ingested = await ingestVoiceComment(c, form)
  if (ingested instanceof Response) return ingested
  const { commentId, audioKey, body } = ingested
  let id: string
  try {
    id = await addComment(c.get('db'), { threadId: thread.id, authorId: c.get('user').id, body, commentId, audioKey })
  } catch (e) {
    await deleteKeys(c.env.GLANCE_FILES, [audioKey]) // compensation: don't orphan the R2 object
    throw e
  }
  await notifyReply(c, site, { thread, commentId: id, snippet: body })
  return c.json({ id }, 201)
}

// PATCH — resolve / reopen a thread (owner or superadmin only). S9c fused pre-write batch; the
// role 403 still comes BEFORE the thread 404 (the batched thread row goes unused on a 403 —
// accepted design, same as the GET list's denial).
comments.patch('/:space/:site/comments/:threadId', async (c) => {
  const gate = await siteWithUrlThread(c)
  if (gate instanceof Response) return gate
  const { site, thread } = gate
  const user = c.get('user')
  if (!canModerate(site, user)) return c.json({ error: 'forbidden' }, 403)
  if (!threadInSite(thread, site.id)) return c.json({ error: 'not found' }, 404)
  const raw = await c.req.json().catch(() => null)
  if (raw?.status === 'resolved') await resolveThread(c.get('db'), thread.id, user.id)
  else if (raw?.status === 'open') await reopenThread(c.get('db'), thread.id)
  else return c.json({ error: 'invalid status' }, 400)
  return c.json({ ok: true })
})

// PATCH — edit a comment (author only). S9c fused pre-write batch (siteWithUrlComment).
comments.patch('/:space/:site/comments/:threadId/messages/:commentId', async (c) => {
  const gate = await siteWithUrlComment(c)
  if (gate instanceof Response) return gate
  const { comment } = gate
  if (comment.authorId !== c.get('user').id) return c.json({ error: 'forbidden' }, 403)
  const raw = await c.req.json().catch(() => null)
  const body = cleanBody(raw?.body)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  await editComment(c.get('db'), comment.threadId, comment.id, body)
  return c.json({ ok: true })
})

// DELETE — soft-delete a comment (author, or owner/superadmin). S9c fused pre-write batch.
comments.delete('/:space/:site/comments/:threadId/messages/:commentId', async (c) => {
  const gate = await siteWithUrlComment(c)
  if (gate instanceof Response) return gate
  const { site, comment } = gate
  const user = c.get('user')
  if (comment.authorId !== user.id && !canModerate(site, user)) return c.json({ error: 'forbidden' }, 403)
  // Capture the audio key before the delete nulls it, then hard-delete the recording off the
  // serving path — the row survives redacted, the audio does not (documented voice asymmetry).
  const { audioKey } = comment
  await deleteComment(c.get('db'), comment.threadId, comment.id)
  if (audioKey) await fireAndForget(c, deleteKeys(c.env.GLANCE_FILES, [audioKey]))
  return c.json({ ok: true })
})
