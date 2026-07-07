import { useSyncExternalStore } from 'react'

// Recently-opened sites/files, for the viewer's left sidebar (and the command palette) so a user
// can jump back. Namespaced by user id (`glance:recents:<userId>`) — a shared machine must not
// leak another user's history, so every call site skips recording until Me has resolved.
//
// The module is split in two: PURE list logic (canonicalize/dedupe/cap/ordering/labeling —
// unit-tested below, no DOM needed) and a thin localStorage + custom-window-event wrapper
// mirroring `theme.ts` (untested here, browser-only; `useRecents` subscribes via
// useSyncExternalStore, not useEffect). The sidebar/palette render a FLAT most-recent-first list —
// one row per visited page — so there's no grouping step, just `entryLabel` per row.

export interface RecentEntry {
  spaceSlug: string
  siteSlug: string
  title: string | null
  /** '' = the site itself (no specific file yet); non-empty = an in-site file path. */
  filePath: string
  /** ISO timestamp of the visit. */
  at: string
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

// The site-open entry (filePath '') and the iframe-ready entry for the same root page are really
// one visit — canonicalize the exact top-level `index.html` down to '' so they dedupe into a
// single row. A NESTED index.html (e.g. `docs/index.html`) is a distinct page and stays as-is.
export function normalizeFilePath(filePath: string): string {
  return filePath === 'index.html' ? '' : filePath
}

// Insert/refresh `entry` most-recent-first, dedup'd by (spaceSlug, siteSlug, filePath), then cap.
export function applyVisit(entries: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const normalized = { ...entry, filePath: normalizeFilePath(entry.filePath) }
  const withoutDup = entries.filter(
    (e) => !(e.spaceSlug === normalized.spaceSlug && e.siteSlug === normalized.siteSlug && e.filePath === normalized.filePath),
  )
  return capEntries([normalized, ...withoutDup])
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

// Most sites come from `glance deploy <file.html>` — a single file kept under its OWN name (not
// index.html) and served at the site root. Opening one records TWO entries for one document: ''
// (site-level, from the loader) and the real filename (from the iframe 'ready'). Collapse that at
// the VIEW level: suppress a site's '' row whenever the site also has a file row. The '' row only
// shows when it's the site's only entry (directory listing, or an index site whose 'ready' was
// canonicalized to '' at record time). Recording stays unchanged.
export function visibleEntries(entries: RecentEntry[]): RecentEntry[] {
  const sitesWithFiles = new Set(entries.filter((e) => e.filePath !== '').map(siteKey))
  return entries.filter((e) => e.filePath !== '' || !sitesWithFiles.has(siteKey(e)))
}

const STRIPPED_EXTENSIONS = ['.html', '.htm', '.md']

function stripKnownExtension(path: string): string {
  const ext = STRIPPED_EXTENSIONS.find((e) => path.endsWith(e))
  return ext ? path.slice(0, path.length - ext.length) : path
}

export interface EntryLabel {
  primary: string
  /** Muted secondary text — the site title (fallback slug), shown on a file row only when it
   *  ADDS information, i.e. differs from the primary label (case-insensitive). A single-file
   *  deploy's slug is the filename sans extension, so its one row stays clean; `docs/setup`
   *  inside site `handbook` does get the secondary label. */
  secondary: string | null
}

// Flat-list row label. The list itself needs no grouping helper: entries are already
// most-recent-first (see `applyVisit`/`readEntries`), one row per visited page.
export function entryLabel(entry: RecentEntry): EntryLabel {
  const siteName = entry.title ?? entry.siteSlug
  if (entry.filePath === '') return { primary: siteName, secondary: null }
  const primary = stripKnownExtension(entry.filePath)
  return { primary, secondary: siteName.toLowerCase() === primary.toLowerCase() ? null : siteName }
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
