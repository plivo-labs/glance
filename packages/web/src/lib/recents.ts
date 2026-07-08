import { useSyncExternalStore } from 'react'

// Recently-opened sites, for the viewer's left sidebar (and the command palette) so a user can
// jump back. Namespaced by user id (`glance:recents:<userId>`) — a shared machine must not leak
// another user's history, so every call site skips recording until Me has resolved.
//
// The module is split in two: PURE list logic (canonicalize/dedupe/cap/ordering — unit-tested
// below, no DOM needed) and a thin localStorage + custom-window-event wrapper mirroring `theme.ts`
// (untested here, browser-only; `useRecents` subscribes via useSyncExternalStore, not useEffect).
//
// ONE row per SITE, labeled by site name (`siteName`), most-recent-first. `filePath` is never
// shown — it's kept only so the row deep-links back to the page visited last within that site.

export interface RecentEntry {
  spaceSlug: string
  siteSlug: string
  title: string | null
  /** '' = the site root; non-empty = the in-site page visited last. Never shown, href only. */
  filePath: string
  /** ISO timestamp of the visit. */
  at: string
}

const EVENT = 'glance:recents'
const MAX_SITES = 15

function storageKey(userId: string): string {
  return `glance:recents:${userId}`
}

function siteKey(e: { spaceSlug: string; siteSlug: string }): string {
  return `${e.spaceSlug}/${e.siteSlug}`
}

// --- Pure logic (unit-tested; no localStorage/window) ------------------------------------------

// The exact top-level `index.html` IS the site root — canonicalize it to '' so the href stays the
// clean `/{space}/{site}` form. A NESTED index.html (e.g. `docs/index.html`) stays as-is.
export function normalizeFilePath(filePath: string): string {
  return filePath === 'index.html' ? '' : filePath
}

// Insert/refresh the site most-recent-first — dedup'd by (spaceSlug, siteSlug), the fresh visit's
// filePath/title replacing the old row's — then cap to MAX_SITES.
export function applyVisit(entries: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const normalized = { ...entry, filePath: normalizeFilePath(entry.filePath) }
  const withoutDup = entries.filter((e) => siteKey(e) !== siteKey(normalized))
  return [normalized, ...withoutDup].slice(0, MAX_SITES)
}

export function applyRemoveEntry(entries: RecentEntry[], match: { spaceSlug: string; siteSlug: string }): RecentEntry[] {
  return entries.filter((e) => siteKey(e) !== siteKey(match))
}

// One row per site, first (= most recent) occurrence wins. `applyVisit` already keeps storage to
// one row per site; this exists for lists persisted before that, which held one row per PAGE.
export function visibleEntries(entries: RecentEntry[]): RecentEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const k = siteKey(e)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function siteName(entry: RecentEntry): string {
  return entry.title ?? entry.siteSlug
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

export function removeEntry(userId: string, match: { spaceSlug: string; siteSlug: string }): void {
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
