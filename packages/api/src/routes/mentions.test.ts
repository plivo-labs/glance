import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { listNotifications } from '../db/notifications'
import { notifications as notificationsTable } from '../db/schema'
import { requireSameOrigin } from '../middleware/auth'
import {
  makeDb,
  makeKv,
  makeR2,
  seedFile,
  seedGroupShare,
  seedMember,
  seedSite,
  seedSpace,
  seedUser,
} from '../test/harness'
import type { AppEnv } from '../types'
import { comments } from './comments'
import { notifications } from './notifications'
import { sites } from './sites'

// Mentions + notifications, wired the way index.ts wires them (requireSameOrigin global; comments
// under /api/sites; notifications at /api/notifications) so CSRF, auth, the mentionable access gate,
// the create/reply intersection, and the notification endpoints are all exercised end to end.

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const r2 = makeR2()
  const kv = makeKv()
  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)
  app.route('/api/sites', comments)
  app.route('/api/notifications', notifications)
  return { db, r2, kv, app, env }
}

async function mintUser(db: ReturnType<typeof makeDb>, kv: ReturnType<typeof makeKv>, id: string) {
  await seedUser(db, { id, name: id })
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@example.com`, name: id, role: 'member' }))
  return id
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' })

/** Seed a space + site (default team) with one HTML file. Returns ids. */
async function seedSiteWithFile(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  ownerId: string,
  visibility: 'private' | 'members' | 'team' = 'team',
) {
  const spaceId = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
  const siteId = await seedSite(db, { spaceId, ownerId, slug: 'doc', visibility })
  await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>The quick brown fox jumps.</p>' })
  return { spaceId, siteId }
}

const commentsUrl = '/api/sites/acme/doc/comments'
const mentionableUrl = '/api/sites/acme/doc/mentionable'

const postThread = (id: string, body: Record<string, unknown>) => ({
  method: 'POST',
  headers: auth(id),
  body: JSON.stringify({ filePath: 'index.html', quote: 'fox', ...body }),
})

// --- C8: mentionable route ---

describe('C8 — GET /mentionable → UserLite[]; 403 for a caller without access', () => {
  test('returns the mentionable list to a viewer with access', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const other = await mintUser(db, kv, 'other')
    await seedSiteWithFile(db, r2, owner, 'team')
    const res = await app.request(mentionableUrl, { headers: auth(other) }, env)
    expect(res.status).toBe(200)
    const list = (await res.json()) as { id: string; name: string | null; email: string }[]
    // team site: everyone but the caller; each row is a UserLite.
    expect(new Set(list.map((u) => u.id))).toEqual(new Set([owner]))
    expect(list[0]).toEqual({ id: 'owner', name: 'owner', email: 'owner@example.com' })
  })

  test('403 for a caller without site access (private, non-owner)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const outsider = await mintUser(db, kv, 'outsider')
    await seedSiteWithFile(db, r2, owner, 'private')
    const res = await app.request(mentionableUrl, { headers: auth(outsider) }, env)
    expect(res.status).toBe(403)
  })
})

// --- C9–C15: mention notifications on create / reply ---

describe('C9 — mentions:[valid] → 1 row for target; none for self even if self is listed', () => {
  test('one target, self ignored', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    const res = await app.request(commentsUrl, postThread(owner, { body: 'hi @target', mentions: [target, owner] }), env)
    expect(res.status).toBe(201)
    const { threadId } = (await res.json()) as { threadId: string }
    const forTarget = await listNotifications(db, target)
    expect(forTarget.unreadCount).toBe(1)
    expect(forTarget.items[0]).toMatchObject({
      type: 'mention',
      actorId: owner,
      actorName: 'owner',
      siteLabel: 'acme/doc',
      filePath: 'index.html',
      threadId,
      snippet: 'hi @target',
    })
    // no self-notification
    expect((await listNotifications(db, owner)).unreadCount).toBe(0)
  })
})

describe('C10 — duplicate @same ids → exactly 1 notification (dedup)', () => {
  test('dedup', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    await app.request(commentsUrl, postThread(owner, { body: 'hey', mentions: [target, target, target] }), env)
    expect((await listNotifications(db, target)).unreadCount).toBe(1)
  })
})

describe('C11 — no-access mention dropped: private space-member 0; group-share member 1', () => {
  test('intersection gate on a private site', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const spaceMember = await mintUser(db, kv, 'spacemember')
    const groupMember = await mintUser(db, kv, 'groupmember')
    const { spaceId, siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    await seedMember(db, spaceId, spaceMember) // member of the site's space — NO access on private
    const grp = await seedSpace(db, { createdBy: groupMember, slug: 'grp' })
    await seedMember(db, grp, groupMember)
    await seedGroupShare(db, siteId, grp) // group-share → access

    await app.request(commentsUrl, postThread(owner, { body: 'ping', mentions: [spaceMember, groupMember] }), env)
    expect((await listNotifications(db, spaceMember)).unreadCount).toBe(0)
    expect((await listNotifications(db, groupMember)).unreadCount).toBe(1)
  })
})

describe('C12 — absent/empty mentions → 0 notifications, comment still created', () => {
  test('no mentions field', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    const res = await app.request(commentsUrl, postThread(owner, { body: 'no mentions here' }), env)
    expect(res.status).toBe(201)
    expect((await listNotifications(db, target)).unreadCount).toBe(0)
  })

  test('empty mentions array', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    await seedSiteWithFile(db, r2, owner, 'team')
    const res = await app.request(commentsUrl, postThread(owner, { body: 'x', mentions: [] }), env)
    expect(res.status).toBe(201)
  })
})

describe('C13 — reply mentions[] → notification created', () => {
  test('reply notifies', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    const created = await (await app.request(commentsUrl, postThread(owner, { body: 'root' }), env)).json()
    const replyUrl = `${commentsUrl}/${(created as { threadId: string }).threadId}/replies`
    const res = await app.request(
      replyUrl,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'cc @target', mentions: [target] }) },
      env,
    )
    expect(res.status).toBe(201)
    const forTarget = await listNotifications(db, target)
    expect(forTarget.unreadCount).toBe(1)
    expect(forTarget.items[0].threadId).toBe((created as { threadId: string }).threadId)
  })
})

describe('C14 — voice thread/reply ignore mentions (v1 hole, pinned)', () => {
  test('a voice thread with a mentions part raises nothing', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    const aiEnv = { ...env, AI: { run: async () => ({ text: 'transcribed' }) } } as unknown as AppEnv['Bindings']
    const fd = new FormData()
    fd.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'take.webm')
    fd.set('filePath', 'index.html')
    fd.set('mentions', JSON.stringify([target])) // voice path never reads this
    const res = await app.request(
      commentsUrl,
      { method: 'POST', headers: { Authorization: `Bearer tok-${owner}`, Origin: APP_URL }, body: fd },
      aiEnv,
    )
    expect(res.status).toBe(201)
    expect((await listNotifications(db, target)).unreadCount).toBe(0)
  })
})

describe('C15 — notify failure does NOT fail the comment (fire-and-forget)', () => {
  test('a throwing notifications insert still commits the comment + 201', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    // Make ONLY the notifications insert throw; the comment insert path is untouched.
    const origInsert = db.insert.bind(db)
    const seam = db as unknown as { insert: (table: unknown) => unknown }
    seam.insert = (table: unknown) => {
      if (table === notificationsTable) throw new Error('boom')
      return origInsert(table as Parameters<typeof origInsert>[0])
    }
    const res = await app.request(commentsUrl, postThread(owner, { body: 'still commits', mentions: [target] }), env)
    expect(res.status).toBe(201)
    seam.insert = origInsert
    // the comment landed…
    const list = await (await app.request(`${commentsUrl}?filePath=index.html`, { headers: auth(owner) }, env)).json()
    expect((list as unknown[]).length).toBe(1)
    // …but the notification did not
    expect((await listNotifications(db, target)).unreadCount).toBe(0)
  })
})

// --- C16: notifications endpoints ---

describe('C16 — GET /api/notifications caller-scoped + unreadCount; POST /read flips readAt', () => {
  test('list is caller-scoped and read marks flip', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    const other = await mintUser(db, kv, 'other')
    await seedSiteWithFile(db, r2, owner, 'team')
    await app.request(commentsUrl, postThread(owner, { body: 'a @target', mentions: [target] }), env)
    await app.request(commentsUrl, postThread(owner, { body: 'b @target', mentions: [target] }), env)

    // caller-scoped: owner and other see none; target sees 2 unread
    expect((await (await app.request('/api/notifications', { headers: auth(other) }, env)).json()).unreadCount).toBe(0)
    const listed = await (await app.request('/api/notifications', { headers: auth(target) }, env)).json()
    expect(listed.items.length).toBe(2)
    expect(listed.unreadCount).toBe(2)

    // mark one read
    const oneId = listed.items[0].id
    await app.request(
      '/api/notifications/read',
      { method: 'POST', headers: auth(target), body: JSON.stringify({ ids: [oneId] }) },
      env,
    )
    expect((await (await app.request('/api/notifications', { headers: auth(target) }, env)).json()).unreadCount).toBe(1)

    // mark all read (no ids)
    await app.request('/api/notifications/read', { method: 'POST', headers: auth(target), body: '{}' }, env)
    expect((await (await app.request('/api/notifications', { headers: auth(target) }, env)).json()).unreadCount).toBe(0)
  })
})
