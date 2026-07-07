import { describe, expect, test } from 'bun:test'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from '../test/harness'
import { deleteSpaceObjects } from './storage'

// deleteSpaceObjects: purge every R2 object for EVERY site in a space in one join query, batched.
// Replaces the N+1 per-site loop the space-delete unit calls.

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
