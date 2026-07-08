import { api } from '@/lib/api'
import { extForMime } from '@/lib/recorder'
import type { ViewerSite } from '@/lib/types'

// Web client for the comments API (mirrors packages/api db/comments ThreadView). Thin wrappers
// over the `api` fetch helper. Anchors are stored, not resolved server-side — the annotate client
// paints each quote by re-finding it in the rendered DOM.

export type ThreadStatus = 'open' | 'resolved'

// An element ("pinpoint") anchor: a client-suggested CSS selector for a whole element (chart,
// table, image) plus a short preview + text fallback. Mirrors the api ElementAnchor; the annotate
// client re-resolves `selector` in the rendered DOM to paint an overlay.
export interface ElementAnchor {
  selector: string
  tag: string
  preview: string
  textFallback: string
}

export interface CommentItem {
  id: string
  authorId: string | null
  author: string | null // display name (name ?? email); kept even when soft-deleted
  body: string | null // null when soft-deleted
  deleted: boolean
  hasAudio?: boolean // voice comment: has a recording; played via the audio route (UI: Step 18)
  createdAt: string
  editedAt: string | null
}

export interface Thread {
  id: string
  filePath: string
  anchorType: 'text' | 'page' | 'element'
  quote: string | null
  anchor: ElementAnchor | null // element threads only
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
}

// A pending anchor the viewer holds between "user picked an anchor" and "user submitted the
// comment" — a text selection, an element pinpoint, or (audio view — no DOM to select in) a bare
// page anchor. Kept generic so the composer + create path don't branch on anchor kind everywhere.
export type PendingAnchor = { kind: 'text'; quote: string } | { kind: 'element'; anchor: ElementAnchor } | { kind: 'page' }

/** Pure map: a pending anchor + body → the create payload. Unit-tested (seam S2) so the viewer's
 *  create path needs no browser to verify. */
export function pendingToInput(filePath: string, body: string, pending: PendingAnchor): NewThreadInput {
  if (pending.kind === 'element') return { filePath, body, anchorType: 'element', element: pending.anchor }
  if (pending.kind === 'page') return { filePath, body, anchorType: 'page' }
  return { filePath, body, quote: pending.quote }
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
  create: (s: SiteRef, input: NewThreadInput) => api.post<{ threadId: string }>(base(s), input),
  reply: (s: SiteRef, threadId: string, body: string) =>
    api.post<{ id: string }>(`${base(s)}/${threadId}/replies`, { body }),
  // Voice thread: multipart create. The recording is `audio`; the anchor fields ride alongside
  // (element serialized as JSON, matching the route). Returns the same shape as `create`.
  createVoice: (s: SiteRef, blob: Blob, fields: VoiceCreateFields) => {
    const form = new FormData()
    form.append('audio', voiceFile(blob))
    form.append('filePath', fields.filePath)
    if (fields.anchorType) form.append('anchorType', fields.anchorType)
    if (fields.quote) form.append('quote', fields.quote)
    if (fields.element) form.append('element', JSON.stringify(fields.element))
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
}
