import { describe, expect, test } from 'bun:test'
import { parseArgs, parseReplyArgs, renderDigest, resolveReplyBody } from './index.ts'

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

  test('renderDigest-element-anchor-line: shows [tag] preview, not a blank line', () => {
    const threads = [
      thread({
        id: 'e1',
        filePath: 'chart.html',
        anchorType: 'element',
        quote: null,
        anchor: { selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' },
      }),
    ] as never
    const out = renderDigest(threads, {})
    expect(out).toContain('> [svg] Bar chart')
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

  test('renderDigest-deleted-marker-never-leaks-body', () => {
    const threads = [
      thread({
        id: 'a',
        filePath: 'one.md',
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

  test('DIG-id-in-heading: thread id renders on the ### heading (reply target)', () => {
    const threads = [thread({ id: 't1', filePath: 'index.md', status: 'open' })] as never
    const out = renderDigest(threads, {})
    // The id is what `glance reply` targets — it must be visible on the plain digest heading.
    expect(out).toContain('### index.md · OPEN · t1')
  })
})

describe('parseReplyArgs', () => {
  test('PRA-happy: space/slug + threadId + message', () => {
    expect(parseReplyArgs(['acme/doc', 't1', 'fixed it'])).toEqual({
      space: 'acme',
      site: 'doc',
      threadId: 't1',
      message: 'fixed it',
    })
  })

  test('PRA-happy: message is optional (stdin path)', () => {
    expect(parseReplyArgs(['acme/doc', 't1'])).toEqual({ space: 'acme', site: 'doc', threadId: 't1' })
  })

  test('PRA-malformed-slug: missing slash / empty segment → error', () => {
    expect('error' in parseReplyArgs(['acme', 't1', 'x'])).toBe(true)
    expect('error' in parseReplyArgs(['acme/', 't1', 'x'])).toBe(true)
    expect('error' in parseReplyArgs(['/doc', 't1', 'x'])).toBe(true)
    expect('error' in parseReplyArgs(['a/b/c', 't1', 'x'])).toBe(true)
  })

  test('PRA-missing-threadId: no threadId → error (slot [1] is threadId, per the happy-optional case, so nothing is shifted)', () => {
    expect('error' in parseReplyArgs(['acme/doc'])).toBe(true)
  })

  test('PRA-dash-sentinel: -- takes a dash-leading message literally', () => {
    expect(parseReplyArgs(['acme/doc', 't1', '--', '--fix the thing'])).toEqual({
      space: 'acme',
      site: 'doc',
      threadId: 't1',
      message: '--fix the thing',
    })
  })

  test('PRA-tag-conflict: --tag and --no-tag together → error', () => {
    expect('error' in parseReplyArgs(['acme/doc', 't1', 'msg', '--tag', 'x', '--no-tag'])).toBe(true)
  })

  test('PRA-blank-tag: trailing --tag (no value) → error', () => {
    expect('error' in parseReplyArgs(['acme/doc', 't1', 'msg', '--tag'])).toBe(true)
  })

  test('PRA-tag-value: --tag <label> carried, positionals intact', () => {
    expect(parseReplyArgs(['acme/doc', 't1', 'msg', '--tag', 'claude'])).toEqual({
      space: 'acme',
      site: 'doc',
      threadId: 't1',
      message: 'msg',
      tag: 'claude',
    })
  })

  test('PRA-no-tag: --no-tag carried as boolean', () => {
    expect(parseReplyArgs(['acme/doc', 't1', 'msg', '--no-tag'])).toEqual({
      space: 'acme',
      site: 'doc',
      threadId: 't1',
      message: 'msg',
      noTag: true,
    })
  })
})

describe('resolveReplyBody', () => {
  test('RB-tag-default: default [agent] prefix', () => {
    expect(resolveReplyBody({ message: 'done' })).toEqual({ body: '[agent] done' })
  })

  test('RB-no-tag: plain human reply, no prefix', () => {
    expect(resolveReplyBody({ message: 'done', noTag: true })).toEqual({ body: 'done' })
  })

  test('RB-tag-custom: --tag label', () => {
    expect(resolveReplyBody({ message: 'done', tag: 'claude' })).toEqual({ body: '[claude] done' })
  })

  test('RB-stdin-fallback: no message → stdin, tagged', () => {
    expect(resolveReplyBody({ message: undefined, stdin: 'from pipe' })).toEqual({ body: '[agent] from pipe' })
  })

  test('RB-message-beats-stdin: positional message wins', () => {
    expect(resolveReplyBody({ message: 'from arg', stdin: 'from pipe' })).toEqual({ body: '[agent] from arg' })
  })

  test('RB-empty-rejected: empty/whitespace, tag cannot rescue it', () => {
    expect('error' in resolveReplyBody({ message: '   ' })).toBe(true)
    expect('error' in resolveReplyBody({ message: undefined, stdin: '' })).toBe(true)
    expect('error' in resolveReplyBody({ message: undefined, stdin: '  \n ' })).toBe(true)
    // even --no-tag can't turn an empty body into a valid one
    expect('error' in resolveReplyBody({ message: '  ', noTag: true })).toBe(true)
  })

  test('RB-trims: surrounding whitespace trimmed, inner newlines preserved', () => {
    expect(resolveReplyBody({ message: '  line1\nline2  ' })).toEqual({ body: '[agent] line1\nline2' })
  })
})
