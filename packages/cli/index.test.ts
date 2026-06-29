import { describe, expect, test } from 'bun:test'
import { parseArgs, renderDigest } from './index.ts'

// Build a ThreadView-ish object (full server shape) so --json passthrough is realistic.
function thread(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 't1',
    filePath: 'index.md',
    anchorType: 'text',
    quote: 'hello',
    anchorStatus: 'anchored',
    start: 0,
    end: 5,
    status: 'open',
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    comments: [
      { id: 'c1', authorId: 'u1', author: 'Ada', body: 'looks good', deleted: false, createdAt: 'x', editedAt: null },
    ],
    ...over,
  }
}

describe('parseArgs', () => {
  test('parseArgs-boolean-flag-not-eat-token', () => {
    const { positional, flags } = parseArgs(['x/y', '--open', '--json'], new Set(['open', 'json']))
    expect(flags.open).toBe(true)
    expect(flags.json).toBe(true)
    expect(positional).toEqual(['x/y'])
  })

  test('parseArgs-value-flags-still-consume', () => {
    const { positional, flags } = parseArgs(['--space', 'docs', '--name', 'r'])
    expect(flags.space).toBe('docs')
    expect(flags.name).toBe('r')
    expect(positional).toEqual([])
  })

  test('parseArgs-boolean-then-positional', () => {
    const { positional, flags } = parseArgs(['--open', 'x/y'], new Set(['open', 'json']))
    expect(positional).toEqual(['x/y'])
    expect(flags.open).toBe(true)
  })
})

describe('renderDigest', () => {
  test('renderDigest-groups-by-file-with-counts', () => {
    // Input is interleaved (one.md, two.md, one.md) so grouping is genuinely exercised: both
    // one.md threads must end up adjacent (before two.md), not in input order.
    const threads = [
      thread({ id: 'a', filePath: 'one.md', status: 'open' }),
      thread({ id: 'b', filePath: 'two.md', status: 'resolved' }),
      thread({ id: 'c', filePath: 'one.md', status: 'open' }),
    ] as never
    const out = renderDigest(threads, {})
    expect(out).toContain('one.md')
    expect(out).toContain('two.md')
    expect(out).toContain('2 open')
    expect(out).toContain('1 resolved')
    // grouping: the LAST one.md heading precedes the two.md heading (same-file threads stay together)
    expect(out.lastIndexOf('one.md')).toBeLessThan(out.indexOf('two.md'))
  })

  test('renderDigest-open-filter-hides-resolved', () => {
    const threads = [
      thread({ id: 'a', filePath: 'one.md', status: 'open', comments: [] }),
      thread({
        id: 'b',
        filePath: 'two.md',
        status: 'resolved',
        comments: [
          {
            id: 'c',
            authorId: 'u',
            author: 'Bob',
            body: 'SECRET_RESOLVED_BODY',
            deleted: false,
            createdAt: 'x',
            editedAt: null,
          },
        ],
      }),
    ] as never
    const out = renderDigest(threads, { open: true })
    expect(out).not.toContain('two.md')
    expect(out).not.toContain('SECRET_RESOLVED_BODY')
    expect(out).toContain('one.md')
  })

  test('renderDigest-deleted-and-orphan-markers', () => {
    const threads = [
      thread({
        id: 'a',
        filePath: 'one.md',
        anchorStatus: 'orphaned',
        quote: null,
        comments: [
          // Defense-in-depth: even if a body somehow rides along on a deleted comment, the
          // renderer must NOT leak it — the deleted branch ignores body entirely.
          {
            id: 'c1',
            authorId: 'u',
            author: 'Ada',
            body: 'SECRET_DELETED_BODY',
            deleted: true,
            createdAt: 'x',
            editedAt: null,
          },
        ],
      }),
    ] as never
    const out = renderDigest(threads, {})
    expect(out).toContain('(deleted)')
    expect(out).toContain('[deleted]')
    expect(out).not.toContain('SECRET_DELETED_BODY') // original body never rendered for deleted
    expect(out).toContain('⚠') // orphaned warning glyph
  })

  test('renderDigest-empty-friendly', () => {
    const out = renderDigest([], {})
    expect(out).toBe('No comments.')
    expect(out.length).toBeGreaterThan(0)
  })

  test('renderDigest-json-passthrough', () => {
    const threads = [thread({ id: 'a' }), thread({ id: 'b', status: 'resolved' })] as never
    const parsed = JSON.parse(renderDigest(threads, { json: true }))
    expect(parsed).toEqual(threads)
  })
})
