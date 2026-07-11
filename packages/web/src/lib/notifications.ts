import { api } from '@/lib/api'
import type { Me } from '@/lib/types'
import type { WhatsNewList } from '@/lib/whatsNew'

// Web client for the notifications API. Mirrors the api NotificationView / listNotifications shape.
// The unread count rides the list response — no separate count endpoint (the root loader carries it).

export interface Notification {
  id: string
  type: 'mention'
  actorId: string | null
  actorName: string | null // display name (name ?? email); null once the actor is deleted
  siteLabel: string | null // "space/slug"
  filePath: string | null
  threadId: string | null
  snippet: string | null
  read: boolean
  readAt: string | null
  createdAt: string
}

export interface NotificationList {
  items: Notification[]
  unreadCount: number
}

export const EMPTY_NOTIFICATIONS: NotificationList = { items: [], unreadCount: 0 }

// The root loader's data: identity (awaited) + DEFERRED promises the header widgets consume via
// <Await> — notifications (Bell/inbox) and whatsNew (Sparkles panel). Lives here (not in the entry
// file) so consumers don't import from main.tsx.
export type RootData = {
  user: Me | null
  notifications: Promise<NotificationList>
  whatsNew: Promise<WhatsNewList>
}

export const notifications = {
  list: () => api.get<NotificationList>('/api/notifications'),
  // Mark read: pass ids for specific rows (click-through), omit to mark ALL read (opening the bell).
  markRead: (ids?: string[]) => api.post<{ ok: true }>('/api/notifications/read', ids ? { ids } : {}),
}
