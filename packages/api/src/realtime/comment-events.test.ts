import { describe, expect, test } from 'bun:test'
import { type DataCapability, signDataToken } from '../lib/data-token'
import { type FakeWebSocket, installWorkerSocketGlobals, makeDurableObjectState, makeWebSocket } from '../test/harness'
import { type CommentEvent, selectCommentRecipients } from './comment-events'
import { SiteRoom, TOKEN_HEADER, encodeAttachment } from './site-room'

// bun is not workerd — see site-room.ts's header comment. These specs pin the comment fan-out
// CONTRACT against the same harness fakes site-room.test.ts uses.
installWorkerSocketGlobals()

const HMAC = 'glance-test-comment-events'
const ENV = { DATA_TOKEN_SECRET: HMAC } as never
const VIEWER: DataCapability[] = ['read', 'create']
const nowSec = () => Math.floor(Date.now() / 1000)

function makeRoom(siteId = 'siteA') {
  const state = makeDurableObjectState(siteId)
  return { state, room: new SiteRoom(state as never, ENV) }
}
type Room = ReturnType<typeof makeRoom>

async function subscribe(r: Room, o: { viewerId: string; caps?: DataCapability[]; channel?: string }) {
  const token = await signDataToken(HMAC, { siteId: 'siteA', viewerId: o.viewerId, caps: o.caps ?? VIEWER }, 300)
  const url = o.channel ? `https://site-room/subscribe?channel=${o.channel}` : 'https://site-room/subscribe'
  const res = await r.room.fetch(new Request(url, { headers: { Upgrade: 'websocket', [TOKEN_HEADER]: token } }))
  return { res, ws: r.state.accepted[r.state.accepted.length - 1]?.ws as FakeWebSocket }
}

function broadcastComment(r: Room, e: CommentEvent) {
  return r.room.fetch(
    new Request('https://site-room/broadcast-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e),
    }),
  )
}

// Attach a hand-built snapshot to an already-accepted socket — the only way to reach the
// woke-up-later states (expired, foreign-site) that a live mint can never produce.
function reattach(ws: FakeWebSocket, o: { subject: string; owner: string; exp: number; caps?: DataCapability[] }) {
  ws.serializeAttachment(encodeAttachment({ caps: VIEWER, ...o }))
}

/** Every object key at any depth — the honest form of "no cursor key at all" (`in` would still
 *  false-positive on `undefined`, and JSON.stringify drops undefined keys anyway). */
function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      keysDeep(v, out)
    }
  }
  return out
}

describe('selectCommentRecipients — pure policy: SITE + EXPIRY, no visibility, no cursor', () => {
  test('C3: exact deliver/close membership — expired and foreign-site attachments CLOSE, never merely skip', () => {
    const exp = nowSec() + 300
    const mine = makeWebSocket()
    reattach(mine, { subject: 'userA', owner: 'siteA', exp })
    const sameSiteOther = makeWebSocket()
    reattach(sameSiteOther, { subject: 'userB', owner: 'siteA', exp })
    const stale = makeWebSocket()
    reattach(stale, { subject: 'userB', owner: 'siteA', exp: nowSec() - 1 })
    const foreignSite = makeWebSocket()
    reattach(foreignSite, { subject: 'userC', owner: 'siteB', exp })
    const unattached = makeWebSocket()

    const event: CommentEvent = { siteId: 'siteA', body: { threadId: 't1', text: 'hi' } }
    const { deliver, close } = selectCommentRecipients(
      event,
      [mine, sameSiteOther, stale, foreignSite, unattached],
      nowSec(),
    )

    // Unlike selectRecipients, EVERY authorized socket delivers — there is no per-document
    // visibility axis (collection/createdBy) to filter on.
    expect(deliver.map((d) => d.auth.subject)).toEqual(['userA', 'userB'])
    // Expired and foreign-site are CLOSED (no longer authorized at all), not silently skipped.
    expect(close).toEqual([stale, foreignSite, unattached])
  })

  test('canViewerRead is never consulted: a body carrying a collection/createdBy that policy would REJECT still delivers', () => {
    const exp = nowSec() + 300
    const ws = makeWebSocket()
    // A bare 'read' cap viewer, reading someone else's document in a non-shared collection, is
    // exactly what canViewerRead rejects (see data-visibility.ts). selectCommentRecipients has no
    // such axis to even ask the question on — site + expiry are fine, so it delivers.
    reattach(ws, { subject: 'userB', owner: 'siteA', exp, caps: ['read'] as DataCapability[] })
    const event: CommentEvent = { siteId: 'siteA', body: { collection: 'notes', createdBy: 'someoneElse' } }
    const { deliver, close } = selectCommentRecipients(event, [ws], nowSec())
    expect(deliver).toHaveLength(1)
    expect(close).toEqual([])
  })
})

describe('SiteRoom — POST /broadcast-comment', () => {
  test('C2: a db-channel socket is NOT a recipient of a comment event — skipped, not closed', async () => {
    const r = makeRoom()
    const { ws: dbSocket } = await subscribe(r, { viewerId: 'userA', channel: 'db' })
    const { ws: commentsSocket } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    await broadcastComment(r, { siteId: 'siteA', body: { threadId: 't1' } })
    expect(commentsSocket.sent).toHaveLength(1)
    expect(dbSocket.sent).toHaveLength(0)
    // Wrong channel is a skip, not a close: the db socket was never even a candidate.
    expect(dbSocket.closed).toEqual([])
  })

  test('C3: an expired attachment really receives close(1008) end-to-end through the room', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    reattach(ws, { subject: 'userA', owner: 'siteA', exp: nowSec() - 1 })
    await broadcastComment(r, { siteId: 'siteA', body: { threadId: 't1' } })
    expect(ws.sent).toEqual([])
    expect(ws.closed).toEqual([{ code: 1008, reason: expect.any(String) }])
  })

  test('the emitted frame is channel-tagged "comments" and carries NO cursor key at all', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    await broadcastComment(r, { siteId: 'siteA', body: { threadId: 't1', text: 'hi' } })
    const [frame] = ws.sent.map((s) => JSON.parse(s))
    expect(frame.channel).toBe('comments')
    expect(keysDeep(frame)).not.toContain('cursor')
  })

  test('a socket whose send() throws is closed and does not stop delivery to the rest', async () => {
    const r = makeRoom()
    const { ws: first } = await subscribe(r, { viewerId: 'u1', channel: 'comments' })
    const { ws: broken } = await subscribe(r, { viewerId: 'u2', channel: 'comments' })
    const { ws: third } = await subscribe(r, { viewerId: 'u3', channel: 'comments' })
    broken.failNextSend(new Error('socket gone'))
    await broadcastComment(r, { siteId: 'siteA', body: { threadId: 't1' } })
    expect(first.sent).toHaveLength(1)
    expect(third.sent).toHaveLength(1)
    expect(broken.sent).toHaveLength(0)
    expect(broken.closed).toHaveLength(1)
  })
})
