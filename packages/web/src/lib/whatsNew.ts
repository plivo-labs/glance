import { api } from '@/lib/api'

// Web client for the What's New API. Mirrors the api Release / whats-new route shape. The unread
// count + the date to mark-seen ride the list response — no separate count endpoint (the root
// loader carries it, like notifications).

export interface Release {
  slug: string
  title: string
  subtitle?: string
  version?: string
  date: string
  featured: boolean
  bodyHtml: string // pre-escaped at build time; injected via dangerouslySetInnerHTML
}

export interface WhatsNewList {
  items: Release[]
  unreadCount: number
  throughDate: string | null // the date to POST back to mark everything seen; null when empty
}

export const EMPTY_WHATS_NEW: WhatsNewList = { items: [], unreadCount: 0, throughDate: null }

export const whatsNew = {
  list: () => api.get<WhatsNewList>('/api/whats-new'),
  // Mark seen up to a date (the response's throughDate) — opening the panel catches the user up.
  seen: (throughDate: string) => api.post<{ ok: true }>('/api/whats-new/seen', { throughDate }),
}

// Pure UI-state transition for opening the What's New panel: optimistically clear the unread badge
// and report the date to persist. No unread → no state change, nothing to persist. Kept pure (no
// fetch, no React) so it's unit-testable; the component wires it to the Sheet's onOpenChange.
export function openWhatsNew(state: WhatsNewList): { state: WhatsNewList; persist: string | null } {
  if (state.unreadCount === 0) return { state, persist: null }
  return { state: { ...state, unreadCount: 0 }, persist: state.throughDate }
}
