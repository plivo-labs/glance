import { describe, expect, test } from 'bun:test'
import { buildCatalog, parseFrontmatter } from './bake'

// Build a raw `.md` note (frontmatter + body) from fields, in author order.
function note(fields: Record<string, string>, body = 'hello'): string {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return `---\n${fm}\n---\n${body}\n`
}
const OLD = '2026-01-01T00:00:00.000Z'
const MID = '2026-03-15T12:30:00.000Z'
const NEW = '2026-06-20T09:00:00.000Z'

describe('A1 parseFrontmatter', () => {
  test('splits flat key:value data from body', () => {
    const { data, body } = parseFrontmatter('---\ntitle: Hi\nslug: hi\n---\nBody line\n')
    expect(data).toEqual({ title: 'Hi', slug: 'hi' })
    expect(body.trim()).toBe('Body line')
  })
  test('missing closing --- throws a named error', () => {
    expect(() => parseFrontmatter('---\ntitle: Hi\nno close here\n')).toThrow(/frontmatter/i)
  })
  test('missing opening --- throws a named error', () => {
    expect(() => parseFrontmatter('title: Hi\nbody\n')).toThrow(/frontmatter/i)
  })
  test('tolerates a leading BOM and blank lines between keys; keeps colons in values', () => {
    const { data, body } = parseFrontmatter('﻿---\ntitle: Hi\n\ndate: 2026-01-01T00:00:00.000Z\n---\nBody\n')
    expect(data).toEqual({ title: 'Hi', date: '2026-01-01T00:00:00.000Z' })
    expect(body.trim()).toBe('Body')
  })
})

describe('A2 required.missing — each absent field throws a DISTINCT error', () => {
  test('missing title', () => {
    expect(buildCatalog([note({ slug: 'a', date: NEW })])).rejects.toThrow(/title/)
  })
  test('missing slug', () => {
    expect(buildCatalog([note({ title: 'A', date: NEW })])).rejects.toThrow(/slug/)
  })
  test('missing date', () => {
    expect(buildCatalog([note({ title: 'A', slug: 'a' })])).rejects.toThrow(/date/)
  })
})

describe('A3 date.canonical — only new Date(v).toISOString()===v is accepted', () => {
  const bad = [
    '2026-07-10', // date-only
    '2026-07-10T00:00:00+05:30', // offset, not Z
    '2026-07-10T00:00:00Z', // seconds-only, no millis
    '2026-07-10T00:00:00.1Z', // variable precision (.1)
    '2026-07-10T00:00:00.0000Z', // variable precision (.0000)
    '2026-02-30T00:00:00.000Z', // invalid calendar date
  ]
  for (const d of bad) {
    test(`rejects ${d}`, () => {
      expect(buildCatalog([note({ title: 'A', slug: 'a', date: d })])).rejects.toThrow(/date/i)
    })
  }
  test('accepts canonical …SS.sssZ', async () => {
    const { newestDate } = await buildCatalog([note({ title: 'A', slug: 'a', date: NEW })])
    expect(newestDate).toBe(NEW)
  })
})

describe('A4 slug.dup.rejected', () => {
  test('two notes, same slug → throws', () => {
    expect(
      buildCatalog([note({ title: 'A', slug: 'dup', date: NEW }), note({ title: 'B', slug: 'dup', date: OLD })]),
    ).rejects.toThrow(/slug/i)
  })
})

describe('A5 date.regress.rejected — guard walks by value not order', () => {
  test('unsorted distinct dates [old,new,mid] succeeds', async () => {
    const { releases } = await buildCatalog([
      note({ title: 'O', slug: 'o', date: OLD }),
      note({ title: 'N', slug: 'n', date: NEW }),
      note({ title: 'M', slug: 'm', date: MID }),
    ])
    expect(releases.map((r) => r.slug)).toEqual(['n', 'm', 'o'])
  })
  test('a duplicate date (== another) throws regardless of array order', () => {
    expect(
      buildCatalog([note({ title: 'A', slug: 'a', date: NEW }), note({ title: 'B', slug: 'b', date: NEW })]),
    ).rejects.toThrow(/date/i)
  })
})

describe('A6 body.escapesRawHtml', () => {
  test('<script>/<img onerror> render ESCAPED in bodyHtml', async () => {
    const { releases } = await buildCatalog([
      note({ title: 'A', slug: 'a', date: NEW }, '<script>alert(1)</script>\n\ntext <img src=x onerror=alert(1)>'),
    ])
    const html = releases[0].bodyHtml
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
  })
})

describe('A7 links.neutralized — scheme obfuscation defused', () => {
  const payloads = [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](javascript:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
  ]
  for (const p of payloads) {
    test(`defuses ${p.slice(0, 24)}`, async () => {
      const { releases } = await buildCatalog([note({ title: 'A', slug: 'a', date: NEW }, p)])
      const html = releases[0].bodyHtml
      expect(html).not.toContain('href="javascript:')
      expect(html).not.toContain('href="vbscript:')
      expect(html).not.toContain('href="data:text/html')
    })
  }
})

describe('A8 sort.descByDate — unsorted input yields desc order', () => {
  test('[old,new,mid] → [new,mid,old] and newestDate===new.date', async () => {
    const { releases, newestDate } = await buildCatalog([
      note({ title: 'O', slug: 'o', date: OLD }),
      note({ title: 'N', slug: 'n', date: NEW }),
      note({ title: 'M', slug: 'm', date: MID }),
    ])
    expect(releases.map((r) => r.date)).toEqual([NEW, MID, OLD])
    expect(newestDate).toBe(NEW)
  })
})

describe('A9 empty.newestNull', () => {
  test('empty source → releases [], newestDate null', async () => {
    const { releases, newestDate } = await buildCatalog([])
    expect(releases).toEqual([])
    expect(newestDate).toBeNull()
  })
})
