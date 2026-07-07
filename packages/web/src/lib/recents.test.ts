import { describe, expect, test } from 'bun:test'
import { applyRemoveEntry, applyVisit, clear, groupBySite, type RecentEntry, recordVisit, removeEntry } from './recents'

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

  test('dedupes by (spaceSlug, siteSlug, filePath), refreshing the timestamp in place', () => {
    const older = entry({ at: '2026-01-01T00:00:00.000Z' })
    const newer = entry({ at: '2026-01-02T00:00:00.000Z', title: 'Renamed' })
    const result = applyVisit([older], newer)
    expect(result).toEqual([newer])
  })

  test('a different filePath on the same site is a distinct entry', () => {
    const root = entry({ filePath: '' })
    const doc = entry({ filePath: 'docs/page.html', at: '2026-01-02T00:00:00.000Z' })
    const result = applyVisit([root], doc)
    expect(result).toEqual([doc, root])
  })

  test('most-recent-first: a repeat visit jumps back to the top', () => {
    const a = entry({ siteSlug: 'a', at: '2026-01-01T00:00:00.000Z' })
    const b = entry({ siteSlug: 'b', at: '2026-01-02T00:00:00.000Z' })
    const aAgain = entry({ siteSlug: 'a', at: '2026-01-03T00:00:00.000Z' })
    const result = applyVisit([b, a], aAgain)
    expect(result.map((e) => e.siteSlug)).toEqual(['a', 'b'])
  })

  test('caps at 15 distinct sites, dropping the whole oldest site together', () => {
    // 15 existing sites, most-recent-first (site-0 newest .. site-14 oldest).
    const existing = Array.from({ length: 15 }, (_, i) => entry({ siteSlug: `site-${i}`, at: `2026-01-${String(30 - i).padStart(2, '0')}T00:00:00.000Z` }))
    const fresh = entry({ siteSlug: 'newcomer', at: '2026-02-01T00:00:00.000Z' })
    const result = applyVisit(existing, fresh)
    const slugs = result.map((e) => e.siteSlug)
    expect(slugs).toContain('newcomer')
    expect(slugs).not.toContain('site-14') // the oldest site was bumped out entirely
    expect(new Set(slugs).size).toBe(15)
  })

  test('caps at 100 total entries even within the site limit', () => {
    const existing = Array.from({ length: 100 }, (_, i) =>
      entry({ filePath: `file-${i}.html`, at: `2026-01-01T00:00:${String(99 - i).padStart(2, '0')}.000Z` }),
    )
    const fresh = entry({ filePath: 'file-100.html', at: '2026-01-01T00:01:00.000Z' })
    const result = applyVisit(existing, fresh)
    expect(result.length).toBe(100)
    expect(result[0]).toEqual(fresh)
    expect(result.some((e) => e.filePath === 'file-99.html')).toBe(false) // oldest row dropped
  })
})

describe('applyRemoveEntry', () => {
  test('filePath given (including "") removes just that one row', () => {
    const root = entry({ filePath: '' })
    const doc = entry({ filePath: 'docs/page.html' })
    const result = applyRemoveEntry([root, doc], { spaceSlug: 'sam', siteSlug: 'demo', filePath: '' })
    expect(result).toEqual([doc])
  })

  test('filePath omitted removes every row for that site', () => {
    const root = entry({ filePath: '' })
    const doc = entry({ filePath: 'docs/page.html' })
    const other = entry({ siteSlug: 'other' })
    const result = applyRemoveEntry([root, doc, other], { spaceSlug: 'sam', siteSlug: 'demo' })
    expect(result).toEqual([other])
  })

  test('a non-matching site is left untouched', () => {
    const a = entry({ siteSlug: 'a' })
    const result = applyRemoveEntry([a], { spaceSlug: 'sam', siteSlug: 'nope' })
    expect(result).toEqual([a])
  })
})

describe('groupBySite', () => {
  test('groups by site, files exclude the site-level ("") row', () => {
    const root = entry({ filePath: '', at: '2026-01-01T00:00:00.000Z' })
    const doc = entry({ filePath: 'docs/page.html', at: '2026-01-02T00:00:00.000Z' })
    const groups = groupBySite([doc, root])
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toEqual([doc])
    expect(groups[0].files.some((f) => f.filePath === '')).toBe(false)
  })

  test('a site with only file-level visits (no root open) still groups', () => {
    const doc = entry({ filePath: 'docs/page.html' })
    const groups = groupBySite([doc])
    expect(groups[0].files).toEqual([doc])
  })

  test('site `at` is the max across its rows, even out of order input', () => {
    const older = entry({ filePath: '', at: '2026-01-01T00:00:00.000Z' })
    const newer = entry({ filePath: 'docs/page.html', at: '2026-01-05T00:00:00.000Z' })
    const groups = groupBySite([older, newer]) // root first, file second — still resolves the max
    expect(groups[0].at).toBe('2026-01-05T00:00:00.000Z')
  })

  test('sites are ordered most-recent-first by their own `at`', () => {
    const a = entry({ siteSlug: 'a', at: '2026-01-01T00:00:00.000Z' })
    const b = entry({ siteSlug: 'b', at: '2026-01-03T00:00:00.000Z' })
    const groups = groupBySite([a, b])
    expect(groups.map((g) => g.siteSlug)).toEqual(['b', 'a'])
  })

  test('files within a site are most-recent-first', () => {
    const older = entry({ filePath: 'a.html', at: '2026-01-01T00:00:00.000Z' })
    const newer = entry({ filePath: 'b.html', at: '2026-01-02T00:00:00.000Z' })
    const groups = groupBySite([older, newer])
    expect(groups[0].files.map((f) => f.filePath)).toEqual(['b.html', 'a.html'])
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

  test('removeEntry(filePath) drops one row; removeEntry(no filePath) drops the whole site', () => {
    recordVisit('u4', { spaceSlug: 'sam', siteSlug: 'demo', title: null, filePath: '' })
    recordVisit('u4', { spaceSlug: 'sam', siteSlug: 'demo', title: null, filePath: 'a.html' })
    removeEntry('u4', { spaceSlug: 'sam', siteSlug: 'demo', filePath: 'a.html' })
    expect(readStored('u4').map((e) => e.filePath)).toEqual([''])
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
