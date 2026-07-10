import { describe, expect, test } from 'bun:test'
import {
  makeDb,
  seedGroupShare,
  seedMember,
  seedSite,
  seedSpace,
  seedUser,
  seedUserShare,
} from '../test/harness'
import { resolveShareRole } from './repo'

// resolveShareRole is the direct-share role reader that gates editor replace, /exists, and manifest.
// It reads ONLY the direct siteUserShares.role — a group share is never an editor grant, and a user
// with no direct share resolves to null (they might still READ via a group/tier, but they can't edit).
describe('resolveShareRole — direct-share editor capability', () => {
  async function fixture() {
    const db = makeDb()
    await seedUser(db, { id: 'owner', email: 'owner@example.com' })
    await seedUser(db, { id: 'ed', email: 'ed@example.com' })
    await seedUser(db, { id: 'vw', email: 'vw@example.com' })
    await seedUser(db, { id: 'grp', email: 'grp@example.com' })
    await seedUser(db, { id: 'stranger', email: 'stranger@example.com' })
    const sp = await seedSpace(db, { id: 'sp', slug: 'acme', createdBy: 'owner' })
    const other = await seedSpace(db, { id: 'other', slug: 'other', createdBy: 'grp' })
    await seedMember(db, other, 'grp')
    const site = await seedSite(db, { id: 'site', spaceId: sp, ownerId: 'owner' })
    await seedUserShare(db, site, 'ed', 'editor')
    await seedUserShare(db, site, 'vw', 'viewer')
    await seedGroupShare(db, site, other) // grp reaches the site via a group share only
    return { db, site }
  }

  test('direct editor share resolves to "editor"', async () => {
    const { db, site } = await fixture()
    expect(await resolveShareRole(db, site, 'ed')).toBe('editor')
  })

  test('direct viewer share resolves to "viewer"', async () => {
    const { db, site } = await fixture()
    expect(await resolveShareRole(db, site, 'vw')).toBe('viewer')
  })

  test('a group-only share is never an editor grant → null', async () => {
    const { db, site } = await fixture()
    expect(await resolveShareRole(db, site, 'grp')).toBeNull()
  })

  test('no share at all → null', async () => {
    const { db, site } = await fixture()
    expect(await resolveShareRole(db, site, 'stranger')).toBeNull()
  })
})
