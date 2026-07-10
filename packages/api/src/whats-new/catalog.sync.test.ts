import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { buildCatalog } from './bake'
import { NEWEST_RELEASE_DATE, RELEASES } from './catalog'

// A11 / S6 — stale-commit guard. CI never regenerates catalog.ts (the main worker's `wrangler
// deploy` has no prebuild), so an author who edits a note but forgets `bun run build:whatsnew`
// would ship a stale catalog. Rebuilding here from the SAME .md sources must match byte-for-byte
// what is committed — otherwise this unit test fails and the drift never reaches prod.
describe('catalog.sync — committed catalog.ts matches a fresh rebuild from the notes', () => {
  test('RELEASES and NEWEST_RELEASE_DATE are in sync with src/whats-new/notes/*.md', async () => {
    const notesDir = join(import.meta.dir, 'notes')
    const raws = readdirSync(notesDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => readFileSync(join(notesDir, f), 'utf8'))
    const { releases, newestDate } = await buildCatalog(raws)
    expect(JSON.parse(JSON.stringify(RELEASES))).toEqual(JSON.parse(JSON.stringify(releases)))
    expect(NEWEST_RELEASE_DATE).toBe(newestDate)
  })
})
