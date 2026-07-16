import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { listNotifications } from '../db/notifications'
import { notifications as notificationsTable, siteUserShares, spaceMembers } from '../db/schema'
import { requireSameOrigin } from '../middleware/auth'
import {
  makeDb,
  makeKv,
  makeR2,
  seedComment,
  seedFile,
  seedGroupShare,
  seedMember,
  seedSite,
  seedSpace,
  seedThread,
  seedUser,
  seedUserShare,
} from '../test/harness'
import type { AppEnv } from '../types'
import { commentFeed } from './comment-feed'
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
  app.route('/api/comments', commentFeed)
  app.route('/api/notifications', notifications)
  return { db, r2, kv, app, env }
}

async function mintUser(
  db: ReturnType<typeof makeDb>,
  kv: ReturnType<typeof makeKv>,
  id: string,
  opts: { role?: 'member' | 'superadmin' } = {},
) {
  const role = opts.role ?? 'member'
  await seedUser(db, { id, name: id, role })
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@example.com`, name: id, role }))
  return id
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' })

/** Seed a space + site (default team) with one HTML file. Returns ids. */
async function seedSiteWithFile(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  ownerId: string,
  visibility: 'private' | 'members' | 'team' = 'team',
  status: 'active' | 'archived' = 'active',
) {
  const spaceId = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
  const siteId = await seedSite(db, { spaceId, ownerId, slug: 'doc', visibility, status })
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

const aiEnv = (base: AppEnv['Bindings'], text: string) =>
  ({ ...base, AI: { run: async () => ({ text }) } }) as unknown as AppEnv['Bindings']

const audioForm = (bytes: Uint8Array, extra: Record<string, string> = {}) => {
  const form = new FormData()
  form.set('audio', new Blob([bytes], { type: 'audio/webm' }), 'take.webm')
  for (const [key, value] of Object.entries(extra)) form.set(key, value)
  return form
}

const voice = (id: string, body: FormData) => ({
  method: 'POST',
  headers: { Authorization: `Bearer tok-${id}`, Origin: APP_URL },
  body,
})

function failNotificationInserts(db: ReturnType<typeof makeDb>) {
  const originalInsert = db.insert.bind(db)
  const seam = db as unknown as { insert: (table: unknown) => unknown }
  let attempts = 0
  seam.insert = (table: unknown) => {
    if (table === notificationsTable) {
      attempts++
      throw new Error('boom')
    }
    return originalInsert(table as Parameters<typeof originalInsert>[0])
  }
  return {
    get attempts() {
      return attempts
    },
    restore() {
      seam.insert = originalInsert
    },
  }
}

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

describe('C14 — voice multipart mentions remain ignored', () => {
  test('a forged mentions part does not create a mention notification', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    // Voice notifications deliberately pass rawMentions: undefined; multipart mentions are unsupported.
    const fd = audioForm(new Uint8Array([1, 2, 3]), { filePath: 'index.html', mentions: JSON.stringify([target]) })
    const res = await app.request(
      commentsUrl,
      voice(owner, fd),
      aiEnv(env, 'transcribed'),
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
    const failure = failNotificationInserts(db)
    const res = await app.request(commentsUrl, postThread(owner, { body: 'still commits', mentions: [target] }), env)
    expect(res.status).toBe(201)
    failure.restore()
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

// --- S2: comment-audience notifications (JSON create + reply only) ---

describe('S2 C1 TRACER — JSON thread without mentions notifies the owner', () => {
  test('owner receives one truncated comment notification tied to the opening comment', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    const body = 'x'.repeat(205)

    const res = await app.request(commentsUrl, postThread(commenter, { body }), env)
    expect(res.status).toBe(201)
    const created = (await res.json()) as { threadId: string; openingCommentId: string }
    const listed = await listNotifications(db, owner)
    expect(listed.unreadCount).toBe(1)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({
      type: 'comment',
      actorName: commenter,
      siteLabel: 'acme/doc',
      filePath: 'index.html',
      threadId: created.threadId,
      commentId: created.openingCommentId,
      snippet: body.slice(0, 200),
    })
  })
})

describe('S2 C2 — owner mention preserves the mention recipient and skips self', () => {
  test('mentioned user gets exactly one mention while owner gets none', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')

    const res = await app.request(commentsUrl, postThread(owner, { body: 'ping', mentions: [target] }), env)
    const created = (await res.json()) as { openingCommentId: string }
    const forTarget = await listNotifications(db, target)
    expect(forTarget.items).toHaveLength(1)
    expect(forTarget.items[0]).toMatchObject({ type: 'mention', commentId: created.openingCommentId })
    expect((await listNotifications(db, owner)).unreadCount).toBe(0)
  })
})

describe('S2 C3 — mentioning the owner wins over owner audience membership', () => {
  test('owner receives exactly one mention row', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')

    await app.request(commentsUrl, postThread(commenter, { body: '@owner', mentions: [owner] }), env)
    const listed = await listNotifications(db, owner)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].type).toBe('mention')
  })
})

describe('S2 C4 — JSON reply notifies the owner with the reply identity', () => {
  test('owner receives one comment row for the reply comment and thread', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    const created = (await (await app.request(commentsUrl, postThread(owner, { body: 'root' }), env)).json()) as {
      threadId: string
    }

    const res = await app.request(
      `${commentsUrl}/${created.threadId}/replies`,
      { method: 'POST', headers: auth(commenter), body: JSON.stringify({ body: 'reply' }) },
      env,
    )
    expect(res.status).toBe(201)
    const reply = (await res.json()) as { id: string }
    const listed = await listNotifications(db, owner)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({ type: 'comment', threadId: created.threadId, commentId: reply.id })
  })
})

describe('S3 C5 — voice thread notifies the owner with the transcript', () => {
  test('owner receives one comment row tied to the opening voice comment', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    const transcript = 'spoken thread transcript'

    const res = await app.request(
      commentsUrl,
      voice(commenter, audioForm(new Uint8Array([1, 2, 3]), { filePath: 'index.html', quote: 'fox' })),
      aiEnv(env, transcript),
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as { threadId: string; openingCommentId: string }
    const listed = await listNotifications(db, owner)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({
      type: 'comment',
      threadId: created.threadId,
      commentId: created.openingCommentId,
      snippet: transcript,
    })
  })
})

describe('S3 C6 — voice reply ignores forged mentions and notifies the owner', () => {
  test('target receives no mention while owner receives one comment row for the voice reply', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    const target = await mintUser(db, kv, 'target')
    await seedSiteWithFile(db, r2, owner, 'team')
    const created = (await (await app.request(commentsUrl, postThread(owner, { body: 'root' }), env)).json()) as {
      threadId: string
    }
    const form = audioForm(new Uint8Array([4, 5, 6]), { mentions: JSON.stringify([target]) })

    const res = await app.request(
      `${commentsUrl}/${created.threadId}/replies`,
      voice(commenter, form),
      aiEnv(env, 'spoken reply transcript'),
    )
    expect(res.status).toBe(201)
    const reply = (await res.json()) as { id: string }
    expect((await listNotifications(db, target)).items).toHaveLength(0)
    expect((await listNotifications(db, owner)).items).toEqual([
      expect.objectContaining({ type: 'comment', threadId: created.threadId, commentId: reply.id }),
    ])
  })
})

describe('S2 C7 — mention and owner audience rows share the comment identity', () => {
  test('mentioned user gets mention and owner gets comment', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')

    const res = await app.request(commentsUrl, postThread(commenter, { body: 'ping', mentions: [target] }), env)
    const created = (await res.json()) as { openingCommentId: string }
    expect((await listNotifications(db, target)).items).toEqual([
      expect.objectContaining({ type: 'mention', commentId: created.openingCommentId }),
    ])
    expect((await listNotifications(db, owner)).items).toEqual([
      expect.objectContaining({ type: 'comment', commentId: created.openingCommentId }),
    ])
  })
})

describe('S2 C8 — direct share is part of the comment audience', () => {
  test('owner thread on a private shared site notifies the directly shared user', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    await seedUserShare(db, siteId, target)

    await app.request(commentsUrl, postThread(owner, { body: 'shared update' }), env)
    const listed = await listNotifications(db, target)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].type).toBe('comment')
  })
})

describe('S2 C9 — team visibility does not make every user comment audience', () => {
  test('an unrelated bystander receives nothing', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    const bystander = await mintUser(db, kv, 'bystander')
    await seedSiteWithFile(db, r2, owner, 'team')

    await app.request(commentsUrl, postThread(commenter, { body: 'update' }), env)
    expect((await listNotifications(db, bystander)).unreadCount).toBe(0)
  })
})

describe('S2 C10 — group-share reach alone is not comment audience', () => {
  test('a group-shared member who did not participate receives nothing', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const member = await mintUser(db, kv, 'member')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    const groupId = await seedSpace(db, { createdBy: member, slug: 'group' })
    await seedMember(db, groupId, member)
    await seedGroupShare(db, siteId, groupId)

    await app.request(commentsUrl, postThread(owner, { body: 'update' }), env)
    expect((await listNotifications(db, member)).unreadCount).toBe(0)
  })
})

describe('S2 C11 — prior thread participants join the reply audience', () => {
  test('prior replier and owner both receive comment notifications', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const prior = await mintUser(db, kv, 'prior')
    const commenter = await mintUser(db, kv, 'commenter')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'team')
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'root' })
    await seedComment(db, { threadId, authorId: prior, body: 'earlier reply' })

    await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(commenter), body: JSON.stringify({ body: 'new reply' }) },
      env,
    )
    expect((await listNotifications(db, prior)).items).toEqual([expect.objectContaining({ type: 'comment' })])
    expect((await listNotifications(db, owner)).items).toEqual([expect.objectContaining({ type: 'comment' })])
  })
})

describe('S2 C12 — revoked private access removes a participant from reply audience', () => {
  test('revoked participant is dropped while owner is notified', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const prior = await mintUser(db, kv, 'prior')
    const commenter = await mintUser(db, kv, 'commenter')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    await seedUserShare(db, siteId, prior)
    await seedUserShare(db, siteId, commenter)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'root' })
    await seedComment(db, { threadId, authorId: prior, body: 'earlier reply' })
    await db.delete(siteUserShares).where(and(eq(siteUserShares.siteId, siteId), eq(siteUserShares.userId, prior)))

    await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(commenter), body: JSON.stringify({ body: 'new reply' }) },
      env,
    )
    expect((await listNotifications(db, prior)).unreadCount).toBe(0)
    expect((await listNotifications(db, owner)).items).toEqual([expect.objectContaining({ type: 'comment' })])
  })
})

describe('S2 — members visibility re-authorizes reply participants', () => {
  test('a participant who is still a space member receives a comment row', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const participant = await mintUser(db, kv, 'participant')
    const { siteId, spaceId } = await seedSiteWithFile(db, r2, owner, 'members')
    await seedMember(db, spaceId, participant)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: participant, body: 'earlier reply' })

    const reply = await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'new reply' }) },
      env,
    )

    expect(reply.status).toBe(201)
    expect((await listNotifications(db, participant)).items).toEqual([expect.objectContaining({ type: 'comment' })])
  })

  test('a participant who left the space is dropped from the reply audience', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const participant = await mintUser(db, kv, 'participant')
    const { siteId, spaceId } = await seedSiteWithFile(db, r2, owner, 'members')
    await seedMember(db, spaceId, participant)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: participant, body: 'earlier reply' })

    // Control: while membership exists, this same audience path admits the participant through
    // the member fact. Removing that fact makes this assertion fail, so the leave check below is
    // not merely observing an unrelated empty audience.
    const beforeLeaving = await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'before leaving' }) },
      env,
    )
    expect(beforeLeaving.status).toBe(201)
    expect((await listNotifications(db, participant)).items).toHaveLength(1)
    await db.delete(notificationsTable).where(eq(notificationsTable.recipientId, participant))
    await db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, participant)))

    const afterLeaving = await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'after leaving' }) },
      env,
    )

    expect(afterLeaving.status).toBe(201)
    expect((await listNotifications(db, participant)).items).toHaveLength(0)
  })
})

describe('S2 C13 — comment-audience notification failure is isolated', () => {
  test('a real notifications insert attempt may throw without failing the comment POST', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    const failure = failNotificationInserts(db)

    const res = await app.request(commentsUrl, postThread(commenter, { body: 'still commits' }), env)
    failure.restore()
    expect(res.status).toBe(201)
    expect(failure.attempts).toBe(1)
  })
})

describe('S2 C17 — soft-deleted participants stay in reply audience and null authors are skipped', () => {
  test('soft-deleted author is notified without a null-recipient failure', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const prior = await mintUser(db, kv, 'prior')
    const commenter = await mintUser(db, kv, 'commenter')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'team')
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'root' })
    await seedComment(db, { threadId, authorId: prior, body: 'deleted reply', deletedAt: new Date().toISOString() })
    await seedComment(db, { threadId, authorId: null, body: 'deleted user' })

    const res = await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(commenter), body: JSON.stringify({ body: 'new reply' }) },
      env,
    )
    expect(res.status).toBe(201)
    expect((await listNotifications(db, prior)).items).toEqual([expect.objectContaining({ type: 'comment' })])
    expect((await listNotifications(db, owner)).items).toEqual([expect.objectContaining({ type: 'comment' })])
  })
})

describe('S2 C18 — a participating group-share user is eligible', () => {
  test('group-share access admits the participant on a later private-site reply', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const participant = await mintUser(db, kv, 'participant')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    const groupId = await seedSpace(db, { createdBy: participant, slug: 'group' })
    await seedMember(db, groupId, participant)
    await seedGroupShare(db, siteId, groupId)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'root' })
    await seedComment(db, { threadId, authorId: participant, body: 'earlier reply' })

    await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'new reply' }) },
      env,
    )
    expect((await listNotifications(db, participant)).items).toEqual([expect.objectContaining({ type: 'comment' })])
  })
})

describe('S2 C19 — direct-share participant mention dedupes to one mention', () => {
  test('the same user receives exactly one row with mention precedence', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    await seedUserShare(db, siteId, target)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'root' })
    await seedComment(db, { threadId, authorId: target, body: 'earlier reply' })

    await app.request(
      `${commentsUrl}/${threadId}/replies`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: '@target', mentions: [target] }) },
      env,
    )
    const listed = await listNotifications(db, target)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].type).toBe('mention')
  })
})

describe('S2 C20 — archived sites suppress comment audience notifications', () => {
  test('a superadmin may comment but the normal owner receives nothing', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const admin = await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await seedSiteWithFile(db, r2, owner, 'team', 'archived')

    const res = await app.request(commentsUrl, postThread(admin, { body: 'admin note' }), env)
    expect(res.status).toBe(201)
    expect((await listNotifications(db, owner)).unreadCount).toBe(0)
  })
})

describe('S3 C21 — voice notification failure preserves the committed comment and audio', () => {
  test('a throwing notification insert leaves the 201, comment, and R2 object intact', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    const failure = failNotificationInserts(db)

    const res = await app.request(
      commentsUrl,
      voice(commenter, audioForm(new Uint8Array([7, 8, 9]), { filePath: 'index.html' })),
      aiEnv(env, 'committed voice transcript'),
    )
    failure.restore()
    expect(res.status).toBe(201)
    expect(failure.attempts).toBe(1)
    const created = (await res.json()) as { openingCommentId: string }
    const threads = (await (
      await app.request(`${commentsUrl}?filePath=index.html`, { headers: auth(owner) }, env)
    ).json()) as { comments: { id: string; body: string }[] }[]
    expect(threads[0].comments).toContainEqual(
      expect.objectContaining({ id: created.openingCommentId, body: 'committed voice transcript' }),
    )
    expect(r2.store.has(`comment-audio/${created.openingCommentId}.webm`)).toBe(true)
    expect((await listNotifications(db, owner)).items).toHaveLength(0)
  })
})

describe('S2 C22 — one notification batch serves every recipient', () => {
  test('owner, direct share, and mention rows are written in one batch and carry commentId', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const shared = await mintUser(db, kv, 'shared')
    const mentioned = await mintUser(db, kv, 'mentioned')
    const commenter = await mintUser(db, kv, 'commenter')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'team')
    await seedUserShare(db, siteId, shared)
    db.resetCounters()

    const res = await app.request(commentsUrl, postThread(commenter, { body: 'ping', mentions: [mentioned] }), env)
    const created = (await res.json()) as { openingCommentId: string }
    // Observed route budget: two loose createThread inserts, then one notification INSERT inside
    // the final batch. The write stays batched for one chunk because 10+ rows must split under
    // D1's 100-bound-parameter cap without adding a round trip.
    expect(db.counters).toEqual({ batches: 4, loose: 2, batchStmts: 9, insert: 3, update: 0, delete: 0 })
    const rows = [
      ...(await listNotifications(db, owner)).items,
      ...(await listNotifications(db, shared)).items,
      ...(await listNotifications(db, mentioned)).items,
    ]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.commentId === created.openingCommentId)).toBe(true)
  })
})

describe('S2 C14 — comment edit and thread resolve do not notify', () => {
  test('owner unread state is unchanged by editing and resolving', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    const created = (await (await app.request(commentsUrl, postThread(commenter, { body: 'root' }), env)).json()) as {
      threadId: string
      openingCommentId: string
    }
    const before = await listNotifications(db, owner)
    expect(before.unreadCount).toBe(1)

    const edit = await app.request(
      `${commentsUrl}/${created.threadId}/messages/${created.openingCommentId}`,
      { method: 'PATCH', headers: auth(commenter), body: JSON.stringify({ body: 'edited' }) },
      env,
    )
    const resolve = await app.request(
      `${commentsUrl}/${created.threadId}`,
      { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status: 'resolved' }) },
      env,
    )
    expect(edit.status).toBe(200)
    expect(resolve.status).toBe(200)
    const after = await listNotifications(db, owner)
    expect(after.unreadCount).toBe(1)
    expect(after.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id))
  })
})

describe('S2 C16 — mark-all-read covers mixed mention and comment notifications', () => {
  test('POST /read with an empty body marks both types read', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const target = await mintUser(db, kv, 'target')
    const { siteId } = await seedSiteWithFile(db, r2, owner, 'private')
    await seedUserShare(db, siteId, target)
    await app.request(commentsUrl, postThread(owner, { body: '@target', mentions: [target] }), env)
    await app.request(commentsUrl, postThread(owner, { body: 'plain update' }), env)
    const before = await listNotifications(db, target)
    expect(new Set(before.items.map((item) => item.type))).toEqual(new Set(['mention', 'comment']))
    expect(before.unreadCount).toBe(2)

    const read = await app.request('/api/notifications/read', { method: 'POST', headers: auth(target), body: '{}' }, env)
    expect(read.status).toBe(200)
    expect((await listNotifications(db, target)).unreadCount).toBe(0)
  })
})

describe('S-A + S2 C15 — comment notifications do not leak into the feed mention arm', () => {
  test('recipient feed excludes an existing comment notification', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    await seedSiteWithFile(db, r2, owner, 'team')
    await app.request(commentsUrl, postThread(commenter, { body: 'plain update' }), env)
    const notification = (await listNotifications(db, owner)).items[0]
    expect(notification.type).toBe('comment')

    const feed = (await (await app.request('/api/comments/feed', { headers: auth(owner) }, env)).json()) as {
      kind: string
      id: string
    }[]
    expect(feed.some((item) => item.id === notification.id)).toBe(false)
    expect(feed.some((item) => item.kind === 'mention')).toBe(false)
  })
})
