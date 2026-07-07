import { describe, expect, test } from 'bun:test'
import { applyRemoveEntry, applyVisit, clear, entryLabel, normalizeFilePath, type RecentEntry, recordVisit, removeEntry } from './recents'

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

  test('canonicalizes top-level index.html to "" before dedupe, so the site-open row and the iframe-ready row for the same root page collapse into one', () => {
    const siteOpen = entry({ filePath: '', at: '2026-01-01T00:00:00.000Z' })
    const iframeReady = entry({ filePath: 'index.html', at: '2026-01-02T00:00:00.000Z', title: 'Renamed' })
    const result = applyVisit([siteOpen], iframeReady)
    expect(result).toEqual([{ ...iframeReady, filePath: '' }])
  })

  test('a NESTED index.html (docs/index.html) is not normalized — stays a distinct row', () => {
    const root = entry({ filePath: '', at: '2026-01-01T00:00:00.000Z' })
    const nested = entry({ filePath: 'docs/index.html', at: '2026-01-02T00:00:00.000Z' })
    const result = applyVisit([root], nested)
    expect(result).toEqual([nested, root])
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

describe('entryLabel', () => {
  test('root row (filePath "") shows the site title as primary, no secondary', () => {
    const label = entryLabel(entry({ filePath: '', title: 'Design Review' }))
    expect(label).toEqual({ primary: 'Design Review', secondary: null })
  })

  test('root row falls back to the site slug when title is null', () => {
    const label = entryLabel(entry({ filePath: '', title: null, siteSlug: 'demo' }))
    expect(label).toEqual({ primary: 'demo', secondary: null })
  })

  test('deep page shows the extension-stripped path as primary, site title as secondary', () => {
    const label = entryLabel(entry({ filePath: 'docs/setup.html', title: 'Docs Site' }))
    expect(label).toEqual({ primary: 'docs/setup', secondary: 'Docs Site' })
  })

  test('deep page falls back to the site slug as secondary when title is null', () => {
    const label = entryLabel(entry({ filePath: 'docs/setup.html', title: null, siteSlug: 'docs-v2' }))
    expect(label).toEqual({ primary: 'docs/setup', secondary: 'docs-v2' })
  })

  test('strips .html, .htm and .md but no other extension', () => {
    expect(entryLabel(entry({ filePath: 'a.html' })).primary).toBe('a')
    expect(entryLabel(entry({ filePath: 'a.htm' })).primary).toBe('a')
    expect(entryLabel(entry({ filePath: 'a.md' })).primary).toBe('a')
    expect(entryLabel(entry({ filePath: 'report.pdf' })).primary).toBe('report.pdf')
  })

  test('a path with no extension is shown as-is', () => {
    expect(entryLabel(entry({ filePath: 'docs/readme' })).primary).toBe('docs/readme')
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
