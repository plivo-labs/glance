import { describe, expect, test } from 'bun:test'
import { makeDb, makeR2, seedComment, seedFile, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { deleteSiteObjects, deleteSpaceObjects } from './storage'

// deleteSpaceObjects: purge every R2 object for EVERY site in a space in one join query, batched.
// Replaces the N+1 per-site loop the space-delete unit calls.

/** Seed a thread + voice comment on a site and put its audio in R2; returns the audio key. */
async function seedVoiceAudio(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  siteId: string,
  key: string,
): Promise<string> {
  const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
  await seedComment(db, { threadId, body: 'transcript', audioKey: key })
  await r2.put(key, 'audio-bytes')
  return key
}

describe('deleteSiteObjects — files + comment audio (W2-15)', () => {
  test('removes BOTH the site file keys and its comment audio keys', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const owner = await seedUser(db, { id: 'u1' })
    const sp = await seedSpace(db, { createdBy: owner })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: owner })

    const fileKey = await seedFile(db, r2, siteId, { path: 'index.html', text: 'page' })
    const audioKey = await seedVoiceAudio(db, r2, siteId, 'comment-audio/s1.webm')
    // A text comment (no audioKey) contributes no R2 key — must not break the collection.
    const textThread = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId: textThread, body: 'text only' })

    await deleteSiteObjects(db, r2 as unknown as R2Bucket, siteId)

    expect(r2.store.has(fileKey)).toBe(false)
    expect(r2.store.has(audioKey)).toBe(false)
  })

  test('does not touch another site’s audio', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const owner = await seedUser(db, { id: 'u1' })
    const sp = await seedSpace(db, { createdBy: owner })
    const target = await seedSite(db, { spaceId: sp, ownerId: owner })
    const other = await seedSite(db, { spaceId: sp, ownerId: owner })
    const targetAudio = await seedVoiceAudio(db, r2, target, 'comment-audio/t.webm')
    const otherAudio = await seedVoiceAudio(db, r2, other, 'comment-audio/o.webm')

    await deleteSiteObjects(db, r2 as unknown as R2Bucket, target)

    expect(r2.store.has(targetAudio)).toBe(false)
    expect(r2.store.has(otherAudio)).toBe(true) // a different site is never touched
  })
})

describe('deleteSpaceObjects (#9)', () => {
  test('deletes-all-keys-in-space-across-sites: leaves other spaces untouched', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const owner = await seedUser(db, { id: 'u1' })

    const spaceA = await seedSpace(db, { createdBy: owner })
    const a1 = await seedSite(db, { spaceId: spaceA, ownerId: owner })
    const a2 = await seedSite(db, { spaceId: spaceA, ownerId: owner })
    const kA = [
      await seedFile(db, r2, a1, { path: 'index.html', text: 'a1' }),
      await seedFile(db, r2, a1, { path: 'assets/app.js', text: 'a1js' }),
      await seedFile(db, r2, a2, { path: 'index.html', text: 'a2' }),
    ]

    const spaceB = await seedSpace(db, { createdBy: owner })
    const b1 = await seedSite(db, { spaceId: spaceB, ownerId: owner })
    const kB = await seedFile(db, r2, b1, { path: 'index.html', text: 'b1' })

    await deleteSpaceObjects(db, r2 as unknown as R2Bucket, spaceA)

    for (const k of kA) expect(r2.store.has(k)).toBe(false)
    expect(r2.store.has(kB)).toBe(true) // a different space is never touched
  })

  test('removes comment audio across every site in the space (W2-16)', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const owner = await seedUser(db, { id: 'u1' })

    const spaceA = await seedSpace(db, { createdBy: owner })
    const a1 = await seedSite(db, { spaceId: spaceA, ownerId: owner })
    const a2 = await seedSite(db, { spaceId: spaceA, ownerId: owner })
    const audioA1 = await seedVoiceAudio(db, r2, a1, 'comment-audio/a1.webm')
    const audioA2 = await seedVoiceAudio(db, r2, a2, 'comment-audio/a2.webm')

    const spaceB = await seedSpace(db, { createdBy: owner })
    const b1 = await seedSite(db, { spaceId: spaceB, ownerId: owner })
    const audioB1 = await seedVoiceAudio(db, r2, b1, 'comment-audio/b1.webm')

    await deleteSpaceObjects(db, r2 as unknown as R2Bucket, spaceA)

    expect(r2.store.has(audioA1)).toBe(false)
    expect(r2.store.has(audioA2)).toBe(false)
    expect(r2.store.has(audioB1)).toBe(true) // a different space is never touched
  })

  test('no-files-is-a-noop: an empty space purges nothing and does not throw', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const owner = await seedUser(db, { id: 'u1' })
    const empty = await seedSpace(db, { createdBy: owner })
    await seedSite(db, { spaceId: empty, ownerId: owner }) // a site with zero files

    await deleteSpaceObjects(db, r2 as unknown as R2Bucket, empty)
    expect(r2.store.size).toBe(0)
  })
})
