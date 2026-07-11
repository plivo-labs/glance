import { describe, expect, test } from 'bun:test'
import { resolveEntryPath } from './entryPath'

// T11.1 — resolveEntryPath mirrors the server's normalizePath (packages/api/src/content.ts). The
// dot/traversal/trailing-slash pairs below are hand-coded FROM that implementation; if the server
// changes, these pins force the mirror to follow. NOTE: a pure suite can't prove the iframe really
// lands on this path — the prefetch stays provisional until glance:ready (see prefetchArbiter),
// and the G4 real-browser smoke covers actual iframe timing.

describe('resolveEntryPath', () => {
  test('root + indexPath index.html → index.html', () => {
    expect(resolveEntryPath('', 'index.html')).toBe('index.html')
  })

  test('root + lone-file indexPath → that file (audio player at the root URL)', () => {
    expect(resolveEntryPath('', 'recording.webm')).toBe('recording.webm')
  })

  test("root + indexPath '' → null (no prefetch), never a guessed index.html", () => {
    expect(resolveEntryPath('', '')).toBeNull()
  })

  test('directory splat maps to its index.html', () => {
    expect(resolveEntryPath('docs/', 'index.html')).toBe('docs/index.html')
    expect(resolveEntryPath('a/b/', '')).toBe('a/b/index.html')
  })

  test('non-empty splat ignores indexPath (indexPath is a ROOT resolution only)', () => {
    expect(resolveEntryPath('docs/', 'recording.webm')).toBe('docs/index.html')
    expect(resolveEntryPath('page.html', 'recording.webm')).toBe('page.html')
  })

  test('plain file paths pass through', () => {
    expect(resolveEntryPath('docs/page.html', 'index.html')).toBe('docs/page.html')
    // no trailing slash = a FILE named docs, exactly like the server
    expect(resolveEntryPath('docs', 'index.html')).toBe('docs')
  })

  // Segment cleaning — pairs hand-coded from content.ts normalizePath: empty, '.' and '..'
  // segments are DROPPED (no traversal), then the dir rule applies to the cleaned path.
  test('dot segments dropped: a/./b → a/b', () => {
    expect(resolveEntryPath('a/./b', 'index.html')).toBe('a/b')
  })

  test('traversal segments dropped (not resolved): a/../b → a/b', () => {
    expect(resolveEntryPath('a/../b', 'index.html')).toBe('a/b')
  })

  test('empty segments collapsed: a//b → a/b', () => {
    expect(resolveEntryPath('a//b', 'index.html')).toBe('a/b')
  })

  test("splat of only droppable segments cleans to the root index: '.' → index.html", () => {
    expect(resolveEntryPath('.', 'whatever.html')).toBe('index.html')
    expect(resolveEntryPath('..', 'whatever.html')).toBe('index.html')
  })

  test("trailing '..' is dropped, remainder treated as a file: a/.. → a", () => {
    expect(resolveEntryPath('a/..', 'index.html')).toBe('a')
  })

  test('dir splat with droppable segments: a/./b/ → a/b/index.html', () => {
    expect(resolveEntryPath('a/./b/', 'index.html')).toBe('a/b/index.html')
  })
})
