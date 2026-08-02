import { api } from '@/lib/api'
import type { MentionUser } from '@/lib/mentions'
import { extForMime } from '@/lib/recorder'
import type { ViewerSite } from '@/lib/types'

// Web client for the comments API (mirrors packages/api db/comments ThreadView). Thin wrappers
// over the `api` fetch helper. Anchors are stored, not resolved server-side — the annotate client
// paints each quote by re-finding it in the rendered DOM.

export type ThreadStatus = 'open' | 'resolved'

/** Text on either side of a selection. Untrusted and advisory: it only steers which occurrence of
 *  a repeated quote gets painted, never whether a comment may exist. */
export type TextContext = { prefix: string; suffix: string }

// An element ("pinpoint") anchor: a client-suggested CSS selector for a whole element (chart,
// table, image) plus a short preview + text fallback. Mirrors the api ElementAnchor; the annotate
// client re-resolves `selector` in the rendered DOM to paint an overlay.
export interface ElementAnchor {
  selector: string
  tag: string
  preview: string
  textFallback: string
}

/** One DISTINCT emoji on a comment, aggregated server-side: how many people used it, whether the
 *  caller is one of them, and the other reactors' display names in reaction order. Mirrors the api
 *  CommentReaction — reactor IDS stay on the server, and `names` is capped there, so it can be
 *  SHORTER than `count` implies: whoever it leaves out is the "and N others" the chip spells out. */
export type CommentReaction = { emoji: string; count: number; mine: boolean; names: string[] }

export interface CommentItem {
  id: string
  authorId: string | null
  author: string | null // display name (name ?? email); kept even when soft-deleted
  body: string | null // null when soft-deleted
  deleted: boolean
  hasAudio?: boolean // voice comment: has a recording; played via the audio route (UI: Step 18)
  // First-reacted-first, [] when nobody has. Present on soft-deleted comments too: the delete
  // redacts the body, it does not rewrite who reacted to it.
  reactions: CommentReaction[]
  createdAt: string
  editedAt: string | null
}

export interface Thread {
  id: string
  filePath: string
  anchorType: 'text' | 'page' | 'element'
  quote: string | null
  anchor: ElementAnchor | null // element threads only
  // Text threads only: the text around the selection, which tells REPEATED occurrences of the same
  // quote apart when painting. Null on threads stored before context existed → first-match painting.
  context: TextContext | null
  status: ThreadStatus
  resolvedBy: string | null
  resolvedByName: string | null
  resolvedAt: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
  comments: CommentItem[]
}

export interface NewThreadInput {
  filePath: string
  body: string
  anchorType?: 'text' | 'page' | 'element'
  quote?: string
  element?: ElementAnchor
  context?: TextContext
}

// A pending anchor the viewer holds between "user picked an anchor" and "user submitted the
// comment": a text selection (from the popover), or a bare page anchor (the audio view, which has
// no DOM to select in). No 'element' variant — element comments are dropped as a creation path
// (RULING, C2a), so existing element THREADS still paint, but nothing composes a new one
// and a payload for it would be unreachable.
export type PendingAnchor = { kind: 'text'; quote: string; context?: TextContext } | { kind: 'page' }

/** Pure map: a pending anchor + body → the create payload. Unit-tested (seam S2) so the viewer's
 *  create path needs no browser to verify. */
export function pendingToInput(filePath: string, body: string, pending: PendingAnchor): NewThreadInput {
  if (pending.kind === 'page') return { filePath, body, anchorType: 'page' }
  // `context` is omitted entirely when absent — the server treats an absent key and an unusable one
  // identically, but sending `undefined` would put a null in the JSON body for no reason.
  return { filePath, body, quote: pending.quote, ...(pending.context ? { context: pending.context } : {}) }
}

/** Attach an explicit mentions list to a JSON payload, but ONLY when there are ids to send — an
 *  empty/absent selection omits the key entirely (the server treats absent = no mentions). Pure so
 *  the create/reply contract is verifiable without a network (seam S-D). */
export function withMentions<T extends object>(payload: T, mentions?: string[]): T | (T & { mentions: string[] }) {
  return mentions && mentions.length > 0 ? { ...payload, mentions } : payload
}

// The paint payload the annotate client understands: a text anchor (re-find quote) or an element
// anchor (re-resolve selector). Mirrors the annotate client's own PaintAnchor.
export type PaintAnchor =
  | { id: string; anchorType: 'text'; quote: string; context: TextContext | null }
  | { id: string; anchorType: 'element'; selector: string }

/** Pure map: which threads the viewer paints into the iframe, and how. The CALLER decides when to
 *  paint (viewer.tsx gates it on the rail being open, since a paint IS the on-page highlight); this
 *  only says what a paint contains. Text threads re-find
 *  their stored quote; element threads re-resolve their stored selector — either kind the iframe
 *  can't locate simply isn't painted (element misses come back reported as orphaned). Extracted
 *  (not inline in viewer.tsx) so this mapping — in particular that element anchors still reach the
 *  iframe — has its own test instead of being provable only by mutating the wiring shell by hand. */
export function paintAnchors(threads: Thread[]): PaintAnchor[] {
  return threads.flatMap((t): PaintAnchor[] => {
    if (t.anchorType === 'text' && t.quote) return [{ id: t.id, anchorType: 'text', quote: t.quote, context: t.context }]
    if (t.anchorType === 'element' && t.anchor) return [{ id: t.id, anchorType: 'element', selector: t.anchor.selector }]
    return []
  })
}

type SiteRef = Pick<ViewerSite, 'spaceSlug' | 'siteSlug'>

// Anchor-shaping fields for a voice thread — everything a create payload carries EXCEPT the body,
// which the server derives from the recording's transcript. Mirrors NewThreadInput sans `body`.
export type VoiceCreateFields = Omit<NewThreadInput, 'body'>

const base = (s: SiteRef) => `/api/sites/${s.spaceSlug}/${s.siteSlug}/comments`

// The recording → a named File the multipart route accepts (its extension, not the MIME, is
// authoritative server-side — extForMime keeps it in the audio allow-list).
const voiceFile = (blob: Blob) => new File([blob], `voice.${extForMime(blob.type)}`, { type: blob.type })

export const comments = {
  list: (s: SiteRef, filePath: string) => api.get<Thread[]>(`${base(s)}?filePath=${encodeURIComponent(filePath)}`),
  // Who the caller may @-mention here (autocomplete source). Same access gate as commenting.
  mentionable: (s: SiteRef) => api.get<MentionUser[]>(`/api/sites/${s.spaceSlug}/${s.siteSlug}/mentionable`),
  create: (s: SiteRef, input: NewThreadInput, mentions?: string[]) =>
    api.post<{ threadId: string }>(base(s), withMentions(input, mentions)),
  reply: (s: SiteRef, threadId: string, body: string, mentions?: string[]) =>
    api.post<{ id: string }>(`${base(s)}/${threadId}/replies`, withMentions({ body }, mentions)),
  // Voice thread: multipart create. The recording is `audio`; the anchor fields ride alongside
  // (element serialized as JSON, matching the route). Returns the same shape as `create`.
  createVoice: (s: SiteRef, blob: Blob, fields: VoiceCreateFields) => {
    const form = new FormData()
    form.append('audio', voiceFile(blob))
    form.append('filePath', fields.filePath)
    if (fields.anchorType) form.append('anchorType', fields.anchorType)
    if (fields.quote) form.append('quote', fields.quote)
    if (fields.element) form.append('element', JSON.stringify(fields.element))
    if (fields.context) form.append('context', JSON.stringify(fields.context))
    return api.postForm<{ threadId: string }>(base(s), form)
  },
  // Voice reply: multipart, audio only (a reply carries no anchor). Same shape as `reply`.
  replyVoice: (s: SiteRef, threadId: string, blob: Blob) => {
    const form = new FormData()
    form.append('audio', voiceFile(blob))
    return api.postForm<{ id: string }>(`${base(s)}/${threadId}/replies`, form)
  },
  setStatus: (s: SiteRef, threadId: string, status: ThreadStatus) =>
    api.patch<{ ok: true }>(`${base(s)}/${threadId}`, { status }),
  edit: (s: SiteRef, threadId: string, commentId: string, body: string) =>
    api.patch<{ ok: true }>(`${base(s)}/${threadId}/messages/${commentId}`, { body }),
  remove: (s: SiteRef, threadId: string, commentId: string) =>
    api.delete<{ ok: true }>(`${base(s)}/${threadId}/messages/${commentId}`),
  // Both toggles answer with the comment's FRESH reaction list, so a caller re-renders from the
  // response instead of refetching the thread. Idempotent server-side: reacting twice, or removing
  // a reaction that isn't there, returns the current list rather than an error.
  react: (s: SiteRef, threadId: string, commentId: string, emoji: string) =>
    api.put<CommentReaction[]>(`${base(s)}/${threadId}/messages/${commentId}/reactions`, { emoji }),
  unreact: (s: SiteRef, threadId: string, commentId: string, emoji: string) =>
    api.delete<CommentReaction[]>(`${base(s)}/${threadId}/messages/${commentId}/reactions`, { emoji }),
}
