import { markdown } from '../lib/markdown'

// Build-time "What's New" bake pipeline. Pure functions (parse → validate → render → sort) that
// turn authored `.md` release notes into a committed catalog. NO filesystem here — the build
// script (scripts/build-whatsnew.ts) reads the files and hands raw strings in, so every guard is
// unit-testable against in-memory arrays. Named errors, not boolean soup: a bad note fails the
// build loudly with a message that names the offending field.

export interface Release {
  slug: string
  title: string
  subtitle?: string
  version?: string
  date: string
  featured: boolean
  bodyHtml: string
}

export interface Catalog {
  releases: Release[]
  newestDate: string | null
}

/** Parse errors carry a name so a failed build points at the exact `.md` problem. */
export class FrontmatterError extends Error {
  name = 'FrontmatterError'
}
export class MissingFieldError extends Error {
  name = 'MissingFieldError'
  constructor(field: string) {
    super(`whats-new note missing required field: ${field}`)
  }
}
export class InvalidDateError extends Error {
  name = 'InvalidDateError'
  constructor(date: string) {
    super(`whats-new note has non-canonical date (must be ISO-8601 UTC …SS.sssZ): ${date}`)
  }
}
export class DuplicateSlugError extends Error {
  name = 'DuplicateSlugError'
  constructor(slug: string) {
    super(`whats-new note has a duplicate slug: ${slug}`)
  }
}
export class DuplicateDateError extends Error {
  name = 'DuplicateDateError'
  constructor(date: string) {
    super(`whats-new note has a duplicate date (dates must be distinct so ordering is unambiguous): ${date}`)
  }
}

/** Split a note's frontmatter block from its markdown body. Restricted grammar: a leading `---`
 *  line, flat `key: value` lines (no nesting, no lists), a closing `---` line, then the body.
 *  Throws FrontmatterError on a malformed block rather than silently returning empty data. */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '') // strip a leading BOM if present
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') {
    throw new FrontmatterError('whats-new note must open with a --- frontmatter delimiter')
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close === -1) {
    throw new FrontmatterError('whats-new note is missing its closing --- frontmatter delimiter')
  }
  const data: Record<string, string> = {}
  for (let i = 1; i < close; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) {
      throw new FrontmatterError(`whats-new frontmatter line is not \`key: value\`: ${line}`)
    }
    data[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { data, body: lines.slice(close + 1).join('\n') }
}

/** A canonical release date is EXACTLY what `Date` round-trips to — `…SS.sssZ`. This makes plain
 *  lexicographic comparison a valid date order (offsets/date-only/variable-precision would break
 *  it: `.001Z` sorts before a bare `Z`). Rejects invalid calendar dates for free. */
export function isCanonicalDate(v: string): boolean {
  const d = new Date(v)
  return !Number.isNaN(d.getTime()) && d.toISOString() === v
}

/** Turn authored `.md` strings into the sorted, validated catalog. Guards run before rendering so
 *  a bad note fails fast. Body is rendered through the SHARED escaping `markdown` (lib/markdown.ts)
 *  — same XSS net as uploaded content. Empty source → empty catalog with a null newestDate. */
export async function buildCatalog(raws: string[]): Promise<Catalog> {
  const slugs = new Set<string>()
  const dates = new Set<string>()
  const parsed = raws.map((raw) => {
    const { data, body } = parseFrontmatter(raw)
    for (const field of ['title', 'slug', 'date'] as const) {
      if (!data[field]) throw new MissingFieldError(field)
    }
    if (!isCanonicalDate(data.date)) throw new InvalidDateError(data.date)
    if (slugs.has(data.slug)) throw new DuplicateSlugError(data.slug)
    slugs.add(data.slug)
    if (dates.has(data.date)) throw new DuplicateDateError(data.date)
    dates.add(data.date)
    return { data, body }
  })

  const releases: Release[] = await Promise.all(
    parsed.map(async ({ data, body }) => ({
      slug: data.slug,
      title: data.title,
      subtitle: data.subtitle || undefined,
      version: data.version || undefined,
      date: data.date,
      featured: data.featured === 'true',
      bodyHtml: await markdown.parse(body),
    })),
  )

  releases.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) // desc by canonical date
  return { releases, newestDate: releases[0]?.date ?? null }
}
