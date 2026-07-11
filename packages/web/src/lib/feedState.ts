// The dashboard's per-feed render brain. The route used to gate every tab on one Promise.all of
// all five feeds; now the component holds one slot per feed (pending/resolved/rejected) and this
// pure function derives the whole tab model from them, so each tab paints as its OWN feed settles.
// Everything decision-shaped lives here, unit-tested: which tabs exist (Shared pops in only once
// its feed resolves with rows), per-tab content (rows / skeleton / contained error), 401 → login
// signal, the ?new=space steering signal, and stability (same data in new slot identities must
// derive an identical model, so revalidation can't churn tabs or steal the active one).

import { ApiError } from './api'
import { slugify } from './slug'
import type { CommentFeedItem, SiteSummary, SpaceSummary, TeamUpload } from './types'

export type FeedSlot<T> =
  | { status: 'pending' }
  | { status: 'resolved'; data: T }
  | { status: 'rejected'; error: unknown }

export interface FeedSlots {
  sites: FeedSlot<SiteSummary[]>
  shared: FeedSlot<SiteSummary[]>
  spaces: FeedSlot<SpaceSummary[]>
  team: FeedSlot<TeamUpload[]>
  comments: FeedSlot<CommentFeedItem[]>
}

export type TabId = 'sites' | 'shared' | 'spaces' | 'team' | 'comments'

export type TabContent<T> =
  | { kind: 'loading' }
  | { kind: 'rows'; rows: T }
  | { kind: 'error'; message: string }

// Discriminated on `id` so the component can switch and get the right row type per tab.
export type DashboardTab =
  | { id: 'sites'; label: 'Your sites'; count: number | null; content: TabContent<SiteSummary[]> }
  | { id: 'shared'; label: 'Shared with me'; count: number; content: TabContent<SiteSummary[]> }
  | { id: 'spaces'; label: 'Your spaces'; count: number | null; content: TabContent<SpaceSummary[]> }
  | { id: 'team'; label: 'Team activity'; count: null; content: TabContent<TeamUpload[]> }
  | { id: 'comments'; label: 'Comments'; count: null; content: TabContent<CommentFeedItem[]> }

export interface FeedState {
  tabs: DashboardTab[]
  // `requestedTab` reconciled against the tabs that actually exist — e.g. Shared emptied or
  // errored away while active → fall back to Your sites so the panel never blanks (#38).
  activeTab: TabId
  // Any feed rejecting with a 401 means the session lapsed; the component redirects to login.
  unauthorized: boolean
  // ?new=space steering: select the Spaces tab so NewSpaceDialog mounts + opens (#6). The Spaces
  // tab always exists (a failed feed degrades inside it), so this fires immediately — gating on
  // the feed resolving would kill the deep link whenever the feed is slow or rejected. Fires only
  // while the active tab is elsewhere — the component consumes it by setting the requested tab,
  // after which re-derives return null (fire-once).
  steerTo: TabId | null
}

const isUnauthorized = (slot: FeedSlot<unknown>): boolean =>
  slot.status === 'rejected' && slot.error instanceof ApiError && slot.error.status === 401

/** A rejected feed's user-facing message: the Error's own, else the fallback. */
export const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

const contentOf = <T>(slot: FeedSlot<T>): TabContent<T> => {
  switch (slot.status) {
    case 'pending':
      return { kind: 'loading' }
    case 'resolved':
      return { kind: 'rows', rows: slot.data }
    case 'rejected':
      return { kind: 'error', message: errorMessage(slot.error, 'Something went wrong. Try refreshing.') }
  }
}

export function deriveFeedState(
  slots: FeedSlots,
  view: { requestedTab: TabId; wantsNewSpace: boolean },
): FeedState {
  const groupSpaces =
    slots.spaces.status === 'resolved' ? slots.spaces.data.filter((s) => s.type === 'group') : null

  // Sites, Spaces, Team and Comments always exist (a failed feed degrades to a contained error INSIDE its
  // tab). Shared exists only once its feed resolves with rows — no tab for an empty or unknown
  // feed, so it pops in on resolve and disappears if a revalidation empties it.
  const tabs: DashboardTab[] = [
    {
      id: 'sites',
      label: 'Your sites',
      count: slots.sites.status === 'resolved' ? slots.sites.data.length : null,
      content: contentOf(slots.sites),
    },
    ...(slots.shared.status === 'resolved' && slots.shared.data.length > 0
      ? [
          {
            id: 'shared',
            label: 'Shared with me',
            count: slots.shared.data.length,
            content: { kind: 'rows', rows: slots.shared.data },
          } as const,
        ]
      : []),
    {
      id: 'spaces',
      label: 'Your spaces',
      count: groupSpaces === null ? null : groupSpaces.length,
      content: groupSpaces === null ? contentOf(slots.spaces) : { kind: 'rows', rows: groupSpaces },
    },
    { id: 'team', label: 'Team activity', count: null, content: contentOf(slots.team) },
    { id: 'comments', label: 'Comments', count: null, content: contentOf(slots.comments) },
  ]

  const activeTab = tabs.some((t) => t.id === view.requestedTab) ? view.requestedTab : 'sites'

  return {
    tabs,
    activeTab,
    unauthorized: Object.values(slots).some(isUnauthorized),
    steerTo: view.wantsNewSpace && activeTab !== 'spaces' ? 'spaces' : null,
  }
}

/** Hide a root file path when it only repeats the site identity. Nested paths remain useful
 *  context even when their basename matches the site slug. */
export function feedRowPath(item: { filePath: string; siteSlug: string }): string | null {
  if (item.filePath === 'index.html') return null
  if (item.filePath.includes('/')) return item.filePath
  const basename = item.filePath.replace(/\.[^.]*$/, '')
  return slugify(basename) === item.siteSlug ? null : item.filePath
}
