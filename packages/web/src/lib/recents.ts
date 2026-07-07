import { useSyncExternalStore } from 'react'

// Recently-opened sites/files, for the viewer's left sidebar (and the command palette) so a user
// can jump back. Namespaced by user id (`glance:recents:<userId>`) — a shared machine must not
// leak another user's history, so every call site skips recording until Me has resolved.
//
// The module is split in two: PURE list logic (dedupe/cap/ordering/grouping — unit-tested below,
// no DOM needed) and a thin localStorage + custom-window-event wrapper mirroring `theme.ts`
// (untested here, browser-only; `useRecents` subscribes via useSyncExternalStore, not useEffect).

export interface RecentEntry {
  spaceSlug: string
  siteSlug: string
  title: string | null
  /** '' = the site itself (no specific file yet); non-empty = an in-site file path. */
  filePath: string
  /** ISO timestamp of the visit. */
  at: string
}

export interface RecentSite {
  spaceSlug: string
  siteSlug: string
  title: string | null
  /** Most recent visit to this site, across its site-level entry and every file. */
  at: string
  /** Opened files (filePath !== ''), most-recent-first. */
  files: RecentEntry[]
}

const EVENT = 'glance:recents'
const MAX_ENTRIES = 100
const MAX_SITES = 15

function storageKey(userId: string): string {
  return `glance:recents:${userId}`
}

function siteKey(e: { spaceSlug: string; siteSlug: string }): string {
  return `${e.spaceSlug}/${e.siteSlug}`
}

// --- Pure logic (unit-tested; no localStorage/window) ------------------------------------------

// Insert/refresh `entry` most-recent-first, dedup'd by (spaceSlug, siteSlug, filePath), then cap.
export function applyVisit(entries: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const withoutDup = entries.filter(
    (e) => !(e.spaceSlug === entry.spaceSlug && e.siteSlug === entry.siteSlug && e.filePath === entry.filePath),
  )
  return capEntries([entry, ...withoutDup])
}

// `filePath` omitted → drop the whole site (every entry, site-level + files). `filePath` given
// (including '') → drop just that one row.
export function applyRemoveEntry(
  entries: RecentEntry[],
  match: { spaceSlug: string; siteSlug: string; filePath?: string },
): RecentEntry[] {
  return entries.filter((e) => {
    if (e.spaceSlug !== match.spaceSlug || e.siteSlug !== match.siteSlug) return true
    return match.filePath !== undefined && e.filePath !== match.filePath
  })
}

// Caps to MAX_SITES distinct sites (a whole site's rows drop together once bumped out by newer
// sites) then MAX_ENTRIES total rows. Robust to unsorted input: the FIRST occurrence of a site in
// iteration order decides whether it's kept, so callers should pass most-recent-first lists.
function capEntries(entries: RecentEntry[]): RecentEntry[] {
  const keptSites = new Set<string>()
  for (const e of entries) {
    const k = siteKey(e)
    if (keptSites.has(k) || keptSites.size < MAX_SITES) keptSites.add(k)
  }
  return entries.filter((e) => keptSites.has(siteKey(e))).slice(0, MAX_ENTRIES)
}

// Groups entries by site, most-recent-first (by the site's own `at`, the max across its rows).
// Files (filePath !== '') are sorted most-recent-first within each group.
export function groupBySite(entries: RecentEntry[]): RecentSite[] {
  const order: string[] = []
  const sites = new Map<string, RecentSite>()
  for (const e of entries) {
    const k = siteKey(e)
    let site = sites.get(k)
    if (!site) {
      site = { spaceSlug: e.spaceSlug, siteSlug: e.siteSlug, title: e.title, at: e.at, files: [] }
      sites.set(k, site)
      order.push(k)
    } else if (e.at > site.at) {
      site.at = e.at
      site.title = e.title
    }
    if (e.filePath) site.files.push(e)
  }
  for (const site of sites.values()) site.files.sort((a, b) => b.at.localeCompare(a.at))
  return order.map((k) => sites.get(k) as RecentSite).sort((a, b) => b.at.localeCompare(a.at))
}

// --- Browser-facing store (localStorage + custom window event) --------------------------------
// Mirrors theme.ts. Not directly unit-tested here (bun test has no DOM); only the pure functions
// above are. `readEntries` caches its parsed result per userId, keyed off the raw string, so
// `useRecents`'s snapshot is referentially stable across renders when nothing changed — required
// by useSyncExternalStore (a snapshot that's a fresh array every call causes an infinite re-render
// loop / a "should be cached" warning).
const EMPTY: RecentEntry[] = []
const parseCache = new Map<string, { raw: string; entries: RecentEntry[] }>()

function readEntries(userId: string): RecentEntry[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey(userId))
  } catch {
    raw = null
  }
  const rawKey = raw ?? ''
  const cached = parseCache.get(userId)
  if (cached && cached.raw === rawKey) return cached.entries
  let entries: RecentEntry[] = EMPTY
  try {
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) entries = parsed
  } catch {
    entries = EMPTY
  }
  parseCache.set(userId, { raw: rawKey, entries })
  return entries
}

function writeEntries(userId: string, entries: RecentEntry[]): void {
  const raw = JSON.stringify(entries)
  parseCache.set(userId, { raw, entries })
  try {
    localStorage.setItem(storageKey(userId), raw)
  } catch {
    /* private mode / storage disabled — ignore */
  }
  window.dispatchEvent(new Event(EVENT))
}

export function recordVisit(userId: string, entry: Omit<RecentEntry, 'at'>): void {
  writeEntries(userId, applyVisit(readEntries(userId), { ...entry, at: new Date().toISOString() }))
}

export function removeEntry(userId: string, match: { spaceSlug: string; siteSlug: string; filePath?: string }): void {
  writeEntries(userId, applyRemoveEntry(readEntries(userId), match))
}

export function clear(userId: string): void {
  writeEntries(userId, [])
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}

export function useRecents(userId: string | null): RecentEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => (userId ? readEntries(userId) : EMPTY),
    () => EMPTY,
  )
}
