import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from '../test/harness'
import { pureAudioSql } from './site-audio'

// The pure-audio predicate as the routes consume it: a correlated scalar selected off the sites
// table (1 = at least one file AND every file audio). Truth table pinned here once; the chunked
// route-level behavior is covered by sites-shared.test.ts (T5.6).

describe('pureAudioSql — predicate truth table', () => {
  async function audioFlagOf(paths: string[]): Promise<number> {
    const db = makeDb()
    const r2 = makeR2()
    const user = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: user })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
    for (const p of paths) await seedFile(db, r2, siteId, { path: p, text: 'x' })
    const [row] = await db.select({ audio: pureAudioSql(sites.id) }).from(sites).where(eq(sites.id, siteId))
    return row.audio
  }

  test('all files audio → 1', async () => {
    expect(await audioFlagOf(['take.webm', 'song.mp3'])).toBe(1)
  })
  test('uppercase extension (LOUD.MP3) still matches → 1', async () => {
    expect(await audioFlagOf(['LOUD.MP3'])).toBe(1)
  })
  test('lookalike suffix (foo.mp3.bak) is not audio → 0', async () => {
    expect(await audioFlagOf(['foo.mp3.bak'])).toBe(0)
  })
  test('a mix of audio + non-audio → 0 (all must be audio)', async () => {
    expect(await audioFlagOf(['song.mp3', 'cover.png'])).toBe(0)
  })
  test('zero files → 0 (at least one file required)', async () => {
    expect(await audioFlagOf([])).toBe(0)
  })
})
