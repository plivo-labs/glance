import { api } from '@/lib/api'
import type { ViewerSite } from '@/lib/types'

// Web client for the comments API (mirrors packages/api db/comments ThreadView). Thin wrappers
// over the `api` fetch helper. Anchors are stored, not resolved server-side — the annotate client
// paints each quote by re-finding it in the rendered DOM.

export type ThreadStatus = 'open' | 'resolved'

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
  anchorType: 'text' | 'page'
  quote: string | null
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
  anchorType?: 'text' | 'page'
  quote?: string
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
