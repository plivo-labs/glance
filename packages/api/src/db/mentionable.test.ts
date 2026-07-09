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
import { listMentionableUsers } from './repo'

// listMentionableUsers must return EXACTLY the set checkAccess would admit, per visibility tier —
// so a mention can never reach someone who can't open the site. Caller is always excluded.

const ids = (list: { id: string }[]) => new Set(list.map((u) => u.id))

describe('C5 — private: owner + user-shares + group-share members only (plain space member excluded)', () => {
  test('private site', async () => {
    const db = makeDb()
    const owner = await seedUser(db)
    const caller = await seedUser(db)
    const shared = await seedUser(db)
    const groupMember = await seedUser(db)
    const plainSpaceMember = await seedUser(db)
    const stranger = await seedUser(db)

    const space = await seedSpace(db, { createdBy: owner })
    await seedMember(db, space, plainSpaceMember) // member of the SITE's space — still excluded on private
    const site = await seedSite(db, { spaceId: space, ownerId: owner, visibility: 'private' })
    await seedUserShare(db, site, shared)

    const grp = await seedSpace(db, { createdBy: groupMember })
    await seedMember(db, grp, groupMember)
    await seedGroupShare(db, site, grp)

    const site_ = { id: site, spaceId: space, visibility: 'private' as const, ownerId: owner, status: 'active' as const }
    const got = ids(await listMentionableUsers(db, site_, caller))
    expect(got).toEqual(new Set([owner, shared, groupMember]))
    expect(got.has(plainSpaceMember)).toBe(false)
    expect(got.has(stranger)).toBe(false)
    expect(got.has(caller)).toBe(false)
  })
})

describe('C6 — members: adds the site space members', () => {
  test('members site', async () => {
    const db = makeDb()
    const owner = await seedUser(db)
    const caller = await seedUser(db)
    const spaceMember = await seedUser(db)
    const stranger = await seedUser(db)

    const space = await seedSpace(db, { createdBy: owner })
    await seedMember(db, space, spaceMember)
    const site = await seedSite(db, { spaceId: space, ownerId: owner, visibility: 'members' })

    const site_ = { id: site, spaceId: space, visibility: 'members' as const, ownerId: owner, status: 'active' as const }
    const got = ids(await listMentionableUsers(db, site_, caller))
    expect(got).toEqual(new Set([owner, spaceMember]))
    expect(got.has(stranger)).toBe(false)
  })
})

describe('C7 — team: all users; always excludes caller', () => {
  test('team site', async () => {
    const db = makeDb()
    const owner = await seedUser(db)
    const caller = await seedUser(db)
    const a = await seedUser(db)
    const b = await seedUser(db)

    const space = await seedSpace(db, { createdBy: owner })
    const site = await seedSite(db, { spaceId: space, ownerId: owner, visibility: 'team' })

    const site_ = { id: site, spaceId: space, visibility: 'team' as const, ownerId: owner, status: 'active' as const }
    const got = ids(await listMentionableUsers(db, site_, caller))
    expect(got).toEqual(new Set([owner, a, b]))
    expect(got.has(caller)).toBe(false)
  })

  test('archived site → nobody is mentionable (410-for-all mirror)', async () => {
    const db = makeDb()
    const owner = await seedUser(db)
    const caller = await seedUser(db)
    await seedUser(db)
    const space = await seedSpace(db, { createdBy: owner })
    const site = await seedSite(db, { spaceId: space, ownerId: owner, visibility: 'team', status: 'archived' })
    const site_ = { id: site, spaceId: space, visibility: 'team' as const, ownerId: owner, status: 'archived' as const }
    expect(await listMentionableUsers(db, site_, caller)).toEqual([])
  })
})
