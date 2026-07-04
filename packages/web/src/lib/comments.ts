import { api } from '@/lib/api'
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
// comment" — a text selection or an element pinpoint. Kept generic so the composer + create path
// don't branch on anchor kind everywhere.
export type PendingAnchor = { kind: 'text'; quote: string } | { kind: 'element'; anchor: ElementAnchor }

/** Pure map: a pending anchor + body → the create payload. Unit-tested (seam S2) so the viewer's
 *  create path needs no browser to verify. */
export function pendingToInput(filePath: string, body: string, pending: PendingAnchor): NewThreadInput {
  return pending.kind === 'element'
    ? { filePath, body, anchorType: 'element', element: pending.anchor }
    : { filePath, body, quote: pending.quote }
}

type SiteRef = Pick<ViewerSite, 'spaceSlug' | 'siteSlug'>

const base = (s: SiteRef) => `/api/sites/${s.spaceSlug}/${s.siteSlug}/comments`

export const comments = {
  list: (s: SiteRef, filePath: string) => api.get<Thread[]>(`${base(s)}?filePath=${encodeURIComponent(filePath)}`),
  create: (s: SiteRef, input: NewThreadInput) => api.post<{ threadId: string }>(base(s), input),
  reply: (s: SiteRef, threadId: string, body: string) =>
    api.post<{ id: string }>(`${base(s)}/${threadId}/replies`, { body }),
  setStatus: (s: SiteRef, threadId: string, status: ThreadStatus) =>
    api.patch<{ ok: true }>(`${base(s)}/${threadId}`, { status }),
  edit: (s: SiteRef, threadId: string, commentId: string, body: string) =>
    api.patch<{ ok: true }>(`${base(s)}/${threadId}/messages/${commentId}`, { body }),
  remove: (s: SiteRef, threadId: string, commentId: string) =>
    api.delete<{ ok: true }>(`${base(s)}/${threadId}/messages/${commentId}`),
}
