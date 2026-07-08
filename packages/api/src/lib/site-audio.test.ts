import { describe, expect, test } from 'bun:test'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from '../test/harness'
import { allAudioSiteIds } from './site-audio'

describe('allAudioSiteIds (W4-1)', () => {
  async function siteWith(paths: string[]) {
    const db = makeDb()
    const r2 = makeR2()
    const user = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: user })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
    for (const p of paths) await seedFile(db, r2, siteId, { path: p, text: 'x' })
    return { db, siteId }
  }

  test('all files audio → flagged', async () => {
    const { db, siteId } = await siteWith(['take.webm'])
    expect((await allAudioSiteIds(db, [siteId])).has(siteId)).toBe(true)
  })
  test('a mix of audio + non-audio → NOT flagged (all must be audio)', async () => {
    const { db, siteId } = await siteWith(['song.mp3', 'cover.png'])
    expect((await allAudioSiteIds(db, [siteId])).has(siteId)).toBe(false)
  })
  test('an HTML site → not flagged', async () => {
    const { db, siteId } = await siteWith(['index.html', 'app.js'])
    expect((await allAudioSiteIds(db, [siteId])).has(siteId)).toBe(false)
  })
  test('empty id list → empty set (no query)', async () => {
    const { db } = await siteWith(['x.mp3'])
    expect((await allAudioSiteIds(db, [])).size).toBe(0)
  })
})
