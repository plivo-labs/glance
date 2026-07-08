import { describe, expect, test } from 'bun:test'
import {
  applyRemoveEntry,
  applyVisit,
  clear,
  normalizeFilePath,
  type RecentEntry,
  recordVisit,
  removeEntry,
  siteName,
  visibleEntries,
} from './recents'

// bun test has no DOM (no window/localStorage) — install a minimal in-memory fake so the
// localStorage-backed wrapper (recordVisit/removeEntry/clear) is exercised directly too, not just
// the pure list functions it delegates to. This is what actually proves per-user namespacing: the
// pure functions below never see a userId, only the keyed storage does.
class FakeStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}
const fakeStorage = new FakeStorage()
globalThis.localStorage = fakeStorage as unknown as Storage
globalThis.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window &
  typeof globalThis

function readStored(userId: string): RecentEntry[] {
  const raw = fakeStorage.getItem(`glance:recents:${userId}`)
  return raw ? JSON.parse(raw) : []
}

// Pure list logic only — no localStorage/window (bun test has no DOM), so this exercises exactly
// the seam `recordVisit`/`removeEntry`/`clear` delegate to.

const entry = (over: Partial<RecentEntry> = {}): RecentEntry => ({
  spaceSlug: 'sam',
  siteSlug: 'demo',
  title: 'Demo',
  filePath: '',
  at: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('applyVisit', () => {
  test('adds a new entry to the front', () => {
    const result = applyVisit([], entry())
    expect(result).toEqual([entry()])
  })

  test('dedupes by SITE — a fresh visit replaces the old row, its filePath/title/timestamp winning', () => {
    const older = entry({ filePath: 'docs/intro.html', at: '2026-01-01T00:00:00.000Z' })
    const newer = entry({ filePath: 'docs/setup.html', at: '2026-01-02T00:00:00.000Z', title: 'Renamed' })
    const result = applyVisit([older], newer)
    expect(result).toEqual([newer])
  })

  test('most-recent-first: a repeat visit jumps back to the top', () => {
    const a = entry({ siteSlug: 'a', at: '2026-01-01T00:00:00.000Z' })
    const b = entry({ siteSlug: 'b', at: '2026-01-02T00:00:00.000Z' })
    const aAgain = entry({ siteSlug: 'a', at: '2026-01-03T00:00:00.000Z' })
    const result = applyVisit([b, a], aAgain)
    expect(result.map((e) => e.siteSlug)).toEqual(['a', 'b'])
  })

  test('same slug in a DIFFERENT space is a distinct site', () => {
    const mine = entry({ spaceSlug: 'sam' })
    const theirs = entry({ spaceSlug: 'ana', at: '2026-01-02T00:00:00.000Z' })
    const result = applyVisit([mine], theirs)
    expect(result).toEqual([theirs, mine])
  })

  test('caps at 15 sites, dropping the oldest', () => {
    const existing = Array.from({ length: 15 }, (_, i) => entry({ siteSlug: `site-${i}`, at: `2026-01-${String(30 - i).padStart(2, '0')}T00:00:00.000Z` }))
    const fresh = entry({ siteSlug: 'newcomer', at: '2026-02-01T00:00:00.000Z' })
    const result = applyVisit(existing, fresh)
    const slugs = result.map((e) => e.siteSlug)
    expect(slugs).toContain('newcomer')
    expect(slugs).not.toContain('site-14') // the oldest site was bumped out
    expect(slugs.length).toBe(15)
  })

  test('canonicalizes top-level index.html to "" so the root href stays /{space}/{site}', () => {
    const result = applyVisit([], entry({ filePath: 'index.html' }))
    expect(result).toEqual([entry({ filePath: '' })])
  })

  test('a NESTED index.html (docs/index.html) is not normalized', () => {
    const result = applyVisit([], entry({ filePath: 'docs/index.html' }))
    expect(result[0].filePath).toBe('docs/index.html')
  })
})

describe('normalizeFilePath', () => {
  test('normalizes the exact top-level index.html to ""', () => {
    expect(normalizeFilePath('index.html')).toBe('')
  })

  test('leaves a nested index.html untouched', () => {
    expect(normalizeFilePath('docs/index.html')).toBe('docs/index.html')
  })

  test('leaves "" and other paths untouched', () => {
    expect(normalizeFilePath('')).toBe('')
    expect(normalizeFilePath('docs/setup.html')).toBe('docs/setup.html')
  })
})

describe('applyRemoveEntry', () => {
  test('removes the matching site', () => {
    const demo = entry()
    const other = entry({ siteSlug: 'other' })
    const result = applyRemoveEntry([demo, other], { spaceSlug: 'sam', siteSlug: 'demo' })
    expect(result).toEqual([other])
  })

  test('a non-matching site is left untouched', () => {
    const a = entry({ siteSlug: 'a' })
    const result = applyRemoveEntry([a], { spaceSlug: 'sam', siteSlug: 'nope' })
    expect(result).toEqual([a])
  })

  test('removes EVERY row of the site (legacy per-page lists)', () => {
    const root = entry({ filePath: '' })
    const doc = entry({ filePath: 'docs/page.html' })
    const other = entry({ siteSlug: 'other' })
    const result = applyRemoveEntry([root, doc, other], { spaceSlug: 'sam', siteSlug: 'demo' })
    expect(result).toEqual([other])
  })
})

describe('visibleEntries', () => {
  test('collapses a legacy per-page list to one row per site, most recent winning', () => {
    const newer = entry({ filePath: 'docs/setup.html', at: '2026-01-02T00:00:00.000Z' })
    const older = entry({ filePath: '', at: '2026-01-01T00:00:00.000Z' })
    expect(visibleEntries([newer, older])).toEqual([newer])
  })

  test('keeps one row per distinct site, order preserved', () => {
    const a = entry({ siteSlug: 'a', filePath: 'a.html' })
    const aRoot = entry({ siteSlug: 'a', filePath: '' })
    const b = entry({ siteSlug: 'b', filePath: '' })
    expect(visibleEntries([a, aRoot, b])).toEqual([a, b])
  })

  test('passes an already-per-site list through unchanged', () => {
    const a = entry({ siteSlug: 'a' })
    const b = entry({ siteSlug: 'b' })
    expect(visibleEntries([a, b])).toEqual([a, b])
  })
})

describe('siteName', () => {
  test('uses the site title', () => {
    expect(siteName(entry({ title: 'Design Review' }))).toBe('Design Review')
  })

  test('falls back to the site slug when title is null', () => {
    expect(siteName(entry({ title: null, siteSlug: 'demo' }))).toBe('demo')
  })
})

describe('recordVisit / removeEntry / clear (localStorage-backed, per-user)', () => {
  test('recordVisit persists under a glance:recents:<userId> key', () => {
    recordVisit('u1', { spaceSlug: 'sam', siteSlug: 'demo', title: 'Demo', filePath: '' })
    const entries = readStored('u1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ spaceSlug: 'sam', siteSlug: 'demo', filePath: '' })
    expect(typeof entries[0].at).toBe('string')
  })

  test('two different user ids never share entries', () => {
    recordVisit('u2a', { spaceSlug: 'sam', siteSlug: 'mine', title: null, filePath: '' })
    recordVisit('u2b', { spaceSlug: 'sam', siteSlug: 'theirs', title: null, filePath: '' })
    expect(readStored('u2a').map((e) => e.siteSlug)).toEqual(['mine'])
    expect(readStored('u2b').map((e) => e.siteSlug)).toEqual(['theirs'])
  })

  test('recordVisit dedupes/reorders through the real store, not just the pure fn', () => {
    recordVisit('u3', { spaceSlug: 'sam', siteSlug: 'a', title: null, filePath: '' })
    recordVisit('u3', { spaceSlug: 'sam', siteSlug: 'b', title: null, filePath: '' })
    recordVisit('u3', { spaceSlug: 'sam', siteSlug: 'a', title: null, filePath: '' }) // revisit bumps to front
    expect(readStored('u3').map((e) => e.siteSlug)).toEqual(['a', 'b'])
  })

  test('a later visit to a page within the site keeps one row, deep-linking to that page', () => {
    recordVisit('u4', { spaceSlug: 'sam', siteSlug: 'demo', title: null, filePath: '' })
    recordVisit('u4', { spaceSlug: 'sam', siteSlug: 'demo', title: null, filePath: 'a.html' })
    expect(readStored('u4').map((e) => e.filePath)).toEqual(['a.html'])
    removeEntry('u4', { spaceSlug: 'sam', siteSlug: 'demo' })
    expect(readStored('u4')).toEqual([])
  })

  test('clear empties one user without touching another', () => {
    recordVisit('u5a', { spaceSlug: 'sam', siteSlug: 'x', title: null, filePath: '' })
    recordVisit('u5b', { spaceSlug: 'sam', siteSlug: 'y', title: null, filePath: '' })
    clear('u5a')
    expect(readStored('u5a')).toEqual([])
    expect(readStored('u5b')).toHaveLength(1)
  })
})
