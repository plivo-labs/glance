import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { type DataCapability, signDataToken } from '../lib/data-token'
import { type FakeWebSocket, installWorkerSocketGlobals, makeDurableObjectState, makeWebSocket } from '../test/harness'
import type { ChangeEvent } from './change-log'
import type { CommentEvent } from './comment-events'
import { decodeCursor } from './cursor'
import { notifyCommentEvent, notifyCommentRoom, notifySiteRoom } from './notify'
import {
  SiteRoom,
  TOKEN_HEADER,
  decodeAttachment,
  encodeAttachment,
  isAttachmentExpired,
  selectRecipients,
} from './site-room'

// bun is NOT workerd: no DO runtime, no hibernation, no eviction, no WebSocketPair. These specs
// pin the hibernation CONTRACT (which API is used, where per-connection state lives, who receives
// what) against the harness fakes. They prove nothing about real hibernation or billing.
installWorkerSocketGlobals()

const HMAC = 'glance-test-siteroom'
const ENV = { DATA_TOKEN_SECRET: HMAC } as never
const VIEWER: DataCapability[] = ['read', 'create']
const OWNER: DataCapability[] = ['read', 'create', 'write', 'read_all']
const nowSec = () => Math.floor(Date.now() / 1000)

function makeRoom(siteId = 'siteA') {
  const state = makeDurableObjectState(siteId)
  return { state, room: new SiteRoom(state as never, ENV) }
}
type Room = ReturnType<typeof makeRoom>

/** Drive the real upgrade path with a real signed data token, returning the socket the room
 *  accepted (the server half of the pair — the client half goes back in the 101). */
async function subscribe(
  r: Room,
  o: { viewerId: string; caps?: DataCapability[]; siteId?: string; ttlSec?: number; token?: string; channel?: string },
) {
  const token =
    o.token ??
    (await signDataToken(
      HMAC,
      { siteId: o.siteId ?? 'siteA', viewerId: o.viewerId, caps: o.caps ?? VIEWER },
      o.ttlSec ?? 300,
    ))
  const url = o.channel ? `https://site-room/subscribe?channel=${o.channel}` : 'https://site-room/subscribe'
  const res = await r.room.fetch(new Request(url, { headers: { Upgrade: 'websocket', [TOKEN_HEADER]: token } }))
  return { res, token, ws: r.state.accepted[r.state.accepted.length - 1]?.ws as FakeWebSocket }
}

function event(o: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    siteId: 'siteA',
    seq: 7,
    collection: 'notes',
    docId: 'doc1',
    createdBy: 'userA',
    type: 'create',
    at: '2026-07-29T00:00:00.000Z',
    ...o,
  }
}

/** A minimal, valid S4-shaped comment.created event — these specs exercise routing/plumbing
 *  (misrouted siteId, deploy wiring), not payload content, so any real CommentEvent will do. */
function commentEvent(o: Partial<Extract<CommentEvent, { type: 'comment.created' }>> = {}): CommentEvent {
  return {
    type: 'comment.created',
    siteId: 'siteA',
    filePath: 'index.html',
    threadId: 't1',
    comment: {
      id: 'c1',
      authorId: null,
      author: null,
      body: 'hi',
      deleted: false,
      hasAudio: false,
      reactions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      editedAt: null,
    },
    ...o,
  }
}

function broadcast(r: Room, e: ChangeEvent = event()) {
  return r.room.fetch(
    new Request('https://site-room/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e),
    }),
  )
}

const frames = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s))

/** Every object key at any depth — the honest form of "the raw seq never reaches a client" (a
 *  substring check would false-positive on three base64url characters of the cursor). */
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

// Attach a hand-built snapshot to an already-accepted socket: the only way to reach the
// woke-up-later states (expired, tampered) that a live mint can never produce.
function reattach(ws: FakeWebSocket, o: { subject: string; owner: string; exp: number; caps?: DataCapability[] }) {
  ws.serializeAttachment(encodeAttachment({ caps: VIEWER, ...o }))
}

describe('SiteRoom — #1/#2/#3/#4: the hibernation contract', () => {
  test('#1: the upgrade accepts through state.acceptWebSocket (tagged), never server.accept()', async () => {
    const r = makeRoom()
    const { res, ws } = await subscribe(r, { viewerId: 'userA' })
    expect(res.status).toBe(101)
    expect(r.state.accepted).toHaveLength(1)
    // accept() would pin the object resident for the socket's whole life — 85% of the free
    // GB-s budget for ONE site.
    expect(ws.accepts).toBe(0)
    // Tags let a woken room select a subset without deserializing every attachment.
    expect(r.state.getTags(ws)).toEqual(['site:siteA', 'viewer:userA', 'chan:db'])
    // The class implements the close half of the hibernation API too.
    await r.room.webSocketClose(ws as never, 1000, 'bye', true)
    expect(ws.closed).toEqual([{ code: 1000, reason: 'bye' }])
  })

  test('#1/#4: fan-out survives a BRAND NEW instance over the same state (no resident socket array)', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    // The closest bun can get to "the object hibernated and woke as a fresh instance".
    const woken = new SiteRoom(r.state as never, ENV)
    await woken.fetch(
      new Request('https://site-room/broadcast', {
        method: 'POST',
        body: JSON.stringify(event({ createdBy: 'userA' })),
      }),
    )
    expect(ws.sent).toHaveLength(1)
  })

  test('#2: no file under src/realtime uses setTimeout/setInterval', () => {
    // A timer anywhere on the DO path blocks hibernation and silently restores the resident cost,
    // so the ban covers every module the room can import, not just site-room.ts.
    const files = readdirSync(import.meta.dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files).toContain('site-room.ts')
    // Comments are stripped first, so the rule can be STATED in prose without tripping over itself.
    const code = (f: string) =>
      readFileSync(join(import.meta.dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
    for (const f of files) expect(code(f)).not.toMatch(/setTimeout|setInterval/)
  })

  test('#3: heartbeats are answered by setWebSocketAutoResponse, not by webSocketMessage', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    const pair = r.state.getWebSocketAutoResponse()
    expect({ request: pair?.request, response: pair?.response }).toEqual({ request: 'ping', response: 'pong' })
    // A ping that DID reach the handler must stay a no-op: no wake work, no reply, no close.
    await r.room.webSocketMessage(ws as never, 'ping')
    expect(ws.sent).toEqual([])
    expect(ws.closed).toEqual([])
  })
})

describe('SiteRoom — #4/#5: per-connection state lives in the attachment', () => {
  test('#4/#5: the attachment round-trips and the bearer token is never in it', async () => {
    const r = makeRoom()
    const { ws, token } = await subscribe(r, { viewerId: 'userA', caps: OWNER })
    expect(decodeAttachment(ws.deserializeAttachment())).toEqual({
      subject: 'userA',
      owner: 'siteA',
      exp: expect.any(Number),
      caps: OWNER,
    })
    // The token genuinely transits this path (it is the upgrade credential), so this can fail.
    expect(JSON.stringify(ws.deserializeAttachment())).not.toContain(token)
    const snapshot = { subject: 'u1', owner: 's1', exp: 123, caps: VIEWER }
    expect(decodeAttachment(encodeAttachment(snapshot))).toEqual(snapshot)
    // encode is a WHITELIST projection: a stray field (a token!) cannot ride along.
    expect(encodeAttachment({ ...snapshot, token } as never)).toEqual(snapshot)
    // Anything that is not a well-formed snapshot is not an identity.
    expect(decodeAttachment(null)).toBeNull()
    expect(decodeAttachment({ subject: 'u1', owner: 's1', exp: 'soon', caps: VIEWER })).toBeNull()
  })

  test('#5 ATTACK: an expired attachment closes the socket on wake instead of delivering', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    // Same socket, one second past its token's exp — the state a 300s token reaches on its own.
    reattach(ws, { subject: 'userA', owner: 'siteA', exp: nowSec() - 1 })
    await broadcast(r, event({ createdBy: 'userA' }))
    expect(ws.sent).toEqual([])
    expect(ws.closed).toEqual([{ code: 1008, reason: expect.any(String) }])
    expect(isAttachmentExpired({ subject: 'u', owner: 's', exp: 100, caps: VIEWER }, 101)).toBe(true)
    expect(isAttachmentExpired({ subject: 'u', owner: 's', exp: 100, caps: VIEWER }, 100)).toBe(false)
  })

  test('#5: a fresh token over the socket re-authorizes it; a foreign identity closes it', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA', ttlSec: 60 })
    const before = decodeAttachment(ws.deserializeAttachment())
    const fresh = await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userA', caps: VIEWER }, 300)
    await r.room.webSocketMessage(ws as never, JSON.stringify({ type: 'auth', token: fresh }))
    const after = decodeAttachment(ws.deserializeAttachment())
    expect(after?.exp).toBeGreaterThan(before?.exp as number)
    expect(ws.closed).toEqual([])
    // A valid token for ANOTHER viewer must not re-point a live socket at a wider identity.
    const other = await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userB', caps: OWNER }, 300)
    await r.room.webSocketMessage(ws as never, JSON.stringify({ type: 'auth', token: other }))
    expect(ws.closed).toHaveLength(1)
    expect(decodeAttachment(ws.deserializeAttachment())).toEqual(after)
  })
})

describe('SiteRoom — #5: the DO re-validates authority itself', () => {
  test('ATTACK: an upgrade without a valid token is refused inside the DO, not just at the worker', async () => {
    const r = makeRoom()
    const bare = await r.room.fetch(new Request('https://site-room/subscribe', { headers: { Upgrade: 'websocket' } }))
    expect(bare.status).toBe(401)
    const junk = await subscribe(r, { viewerId: 'userA', token: 'not-a-token' })
    expect(junk.res.status).toBe(401)
    const foreignSecret = await signDataToken('some-other-secret', {
      siteId: 'siteA',
      viewerId: 'userA',
      caps: OWNER,
    })
    const forged = await subscribe(r, { viewerId: 'userA', token: foreignSecret })
    expect(forged.res.status).toBe(401)
    expect(r.state.accepted).toHaveLength(0)
  })

  test('ATTACK: a token for another site cannot join this room', async () => {
    const r = makeRoom('siteA')
    const { res } = await subscribe(r, { viewerId: 'userB', siteId: 'siteB', caps: OWNER })
    expect(res.status).toBe(403)
    expect(r.state.accepted).toHaveLength(0)
  })

  test('a non-upgrade request on /subscribe is not a socket', async () => {
    const r = makeRoom()
    const token = await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userA', caps: VIEWER })
    const res = await r.room.fetch(new Request('https://site-room/subscribe', { headers: { [TOKEN_HEADER]: token } }))
    expect(res.status).toBe(426)
    expect(r.state.accepted).toHaveLength(0)
  })
})

describe('SiteRoom — #6: a push is a SECOND read path', () => {
  test('#6 ATTACK: viewer B never receives an event for viewer A private-collection document', async () => {
    const r = makeRoom()
    const { ws: a } = await subscribe(r, { viewerId: 'userA' })
    const { ws: b } = await subscribe(r, { viewerId: 'userB' })
    const { ws: owner } = await subscribe(r, { viewerId: 'owner1', caps: OWNER })

    await broadcast(r, event({ seq: 1, collection: 'notes', createdBy: 'userA' }))
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
    expect(owner.sent).toHaveLength(1)

    // `shared-*` widens reads to every site viewer…
    await broadcast(r, event({ seq: 2, collection: 'shared-poll', createdBy: 'userA' }))
    expect(b.sent).toHaveLength(1)
    expect(a.sent).toHaveLength(2)
    expect(owner.sent).toHaveLength(2)

    // …and a read_all token sees every creator's rows in every collection.
    await broadcast(r, event({ seq: 3, collection: 'notes', createdBy: 'userB' }))
    expect(a.sent).toHaveLength(2)
    expect(b.sent).toHaveLength(2)
    expect(owner.sent).toHaveLength(3)
    // Nobody was disconnected by an ordinary filtered-out event.
    expect([a.closed, b.closed, owner.closed]).toEqual([[], [], []])
  })

  test('#6: selectRecipients decides from the attachment snapshots alone', async () => {
    const exp = nowSec() + 300
    const mine = makeWebSocket()
    reattach(mine, { subject: 'userA', owner: 'siteA', exp })
    const theirs = makeWebSocket()
    reattach(theirs, { subject: 'userB', owner: 'siteA', exp })
    const stale = makeWebSocket()
    reattach(stale, { subject: 'userB', owner: 'siteA', exp: nowSec() - 1 })
    const unattached = makeWebSocket()

    const picked = selectRecipients(
      event({ collection: 'notes', createdBy: 'userA' }),
      [mine, theirs, stale, unattached],
      nowSec(),
    )
    expect(picked.deliver.map((d) => d.auth.subject)).toEqual(['userA'])
    // Skipped (policy) is not the same as closed (no longer authorized at all).
    expect(picked.close).toEqual([stale, unattached])
  })

  test('#6 ATTACK: a socket whose attachment names another site receives nothing', async () => {
    const r = makeRoom('siteA')
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    // read_all + own document: every OTHER check would deliver this. Only the site wall stops it.
    reattach(ws, { subject: 'userA', owner: 'siteB', exp: nowSec() + 300, caps: OWNER })
    await broadcast(r, event({ createdBy: 'userA' }))
    expect(ws.sent).toEqual([])
    expect(ws.closed).toHaveLength(1)
  })
})

describe('SiteRoom — #9/#10: the delivered frame', () => {
  test('#9: every frame carries an opaque cursor and never the raw seq', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    await broadcast(r, event({ seq: 42, createdBy: 'userA' }))
    const [frame] = frames(ws)
    // Identical to a replayed catch-up event, so onCreate cannot tell live from replay.
    expect(frame.events).toEqual([
      { type: 'create', collection: 'notes', id: 'doc1', createdBy: 'userA', at: '2026-07-29T00:00:00.000Z' },
    ])
    expect(keysDeep(frame)).not.toContain('seq')
    // …and the position is only readable with the server's secret, per viewer.
    expect(await decodeCursor(HMAC, frame.cursor)).toEqual({ siteId: 'siteA', viewerId: 'userA', seq: 42 })
    expect(await decodeCursor('another-secret', frame.cursor)).toBeNull()
  })

  test('a socket whose send() throws is closed and does not stop delivery to the rest', async () => {
    const r = makeRoom()
    const { ws: first } = await subscribe(r, { viewerId: 'u1' })
    const { ws: broken } = await subscribe(r, { viewerId: 'u2' })
    const { ws: third } = await subscribe(r, { viewerId: 'u3' })
    broken.failNextSend(new Error('socket gone'))
    await broadcast(r, event({ collection: 'shared-poll', createdBy: 'u9' }))
    expect(first.sent).toHaveLength(1)
    expect(third.sent).toHaveLength(1)
    expect(broken.sent).toHaveLength(0)
    expect(broken.closed).toHaveLength(1)
  })
})

describe('SiteRoom — S1: channel-tagged sockets', () => {
  test('C1 ATTACK: a comments-channel socket is never a candidate for a shared-* document event', async () => {
    const r = makeRoom()
    const { ws: dbSocket } = await subscribe(r, { viewerId: 'userA', channel: 'db' })
    const { ws: commentsSocket } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    // shared-* would deliver to every site viewer on the db channel — the comments socket must
    // not even be a CANDIDATE, not merely filtered out by policy.
    await broadcast(r, event({ collection: 'shared-poll', createdBy: 'userA' }))
    expect(dbSocket.sent).toHaveLength(1)
    expect(commentsSocket.sent).toHaveLength(0)
    expect(commentsSocket.closed).toEqual([])
  })

  test('default-channel characterization: /subscribe with no channel param behaves exactly as today', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    expect(r.state.getTags(ws)).toContain('chan:db')
    await broadcast(r, event({ createdBy: 'userA' }))
    expect(ws.sent).toHaveLength(1)
  })

  test('an unrecognised channel value also defaults to db', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA', channel: 'bogus' })
    expect(r.state.getTags(ws)).toContain('chan:db')
  })

  test('C4: a db frame carries events + cursor at the same keys, plus channel:"db", and is still additive to dbBroker.parseFrame', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    await broadcast(r, event({ seq: 42, createdBy: 'userA' }))
    const [frame] = frames(ws)
    expect(frame).toEqual({
      channel: 'db',
      events: [{ type: 'create', collection: 'notes', id: 'doc1', createdBy: 'userA', at: '2026-07-29T00:00:00.000Z' }],
      cursor: expect.any(String),
    })
    // Mirrors packages/web/src/lib/dbBroker.ts's parseFrame (not imported — the repo deliberately
    // keeps api and web decoupled): it reads only f.events + f.cursor and ignores unknown keys, so
    // an additive `channel` field must not break it.
    const parseFrame = (data: string): { events: unknown[]; cursor: string } | null => {
      const f = JSON.parse(data) as { events?: unknown; cursor?: unknown }
      return Array.isArray(f?.events) && typeof f.cursor === 'string' ? { events: f.events, cursor: f.cursor } : null
    }
    expect(parseFrame(ws.sent[0])).toEqual({ events: frame.events, cursor: frame.cursor })
  })

  test('a comments frame carries the whole event payload, not just siteId — the spread must actually reach the wire', async () => {
    const r = makeRoom()
    const { ws } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const e = commentEvent({ filePath: 'index.html', threadId: 't1' })
    await r.room.fetch(
      new Request('https://site-room/broadcast-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(e),
      }),
    )
    // `{ channel: 'comments', ...e }` must survive the wire round trip: a frame reduced to just
    // siteId would still pass every other spec here (they only check length/type/threadId), so
    // this asserts the FULL parsed frame — type/filePath/thread|comment included.
    const [frame] = frames(ws)
    expect(frame).toEqual({ channel: 'comments', ...e })
  })
})

describe('SiteRoom — T2: a misrouted broadcast body is a no-op, not a site-wide disconnect', () => {
  test('T2 db: a room named siteA receiving a broadcast body for siteB delivers to nobody and closes nobody', async () => {
    const r = makeRoom('siteA')
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    await broadcast(r, event({ siteId: 'siteB', createdBy: 'userA' }))
    expect(ws.sent).toEqual([])
    expect(ws.closed).toEqual([])
  })

  test('T2 comments: a room named siteA receiving a comment-broadcast body for siteB delivers to nobody and closes nobody', async () => {
    const r = makeRoom('siteA')
    const { ws } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    await r.room.fetch(
      new Request('https://site-room/broadcast-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commentEvent({ siteId: 'siteB' })),
      }),
    )
    expect(ws.sent).toEqual([])
    expect(ws.closed).toEqual([])
  })

  test('T2 regression guard: a correctly-routed db broadcast still delivers exactly as before', async () => {
    const r = makeRoom('siteA')
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    await broadcast(r, event({ createdBy: 'userA' }))
    expect(ws.sent).toHaveLength(1)
    expect(ws.closed).toEqual([])
  })
})

describe('SiteRoom — S10: typing, the first inbound message that is not auth', () => {
  const typing = (r: Room, ws: FakeWebSocket, msg: unknown) => r.room.webSocketMessage(ws as never, JSON.stringify(msg))

  test('a typing message fans out {viewerId, threadId, expiresAt} to the OTHER comments sockets — never the sender, never a chan:db socket', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: peer } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    // caps:[] is NOT what keeps this off the db rail (Phase 2's journal) — the channel tag is.
    const { ws: dbSocket } = await subscribe(r, { viewerId: 'userC', channel: 'db' })
    const before = Date.now()
    await typing(r, sender, { type: 'typing', threadId: 't1' })

    expect(frames(peer)).toEqual([
      { channel: 'comments', type: 'typing', viewerId: 'userA', threadId: 't1', expiresAt: expect.any(Number) },
    ])
    // Absolute, so the RECEIVER forgets the indicator on its own clock and the DO needs no timer.
    expect(frames(peer)[0].expiresAt).toBeGreaterThan(before)
    // The sender already knows it is typing, and a db socket is not even a candidate.
    expect([sender.sent, dbSocket.sent]).toEqual([[], []])
    expect([sender.closed, peer.closed, dbSocket.closed]).toEqual([[], [], []])
  })

  test('C17 ATTACK: a viewerId in the payload is ignored — attribution is the attachment subject', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: peer } = await subscribe(r, { viewerId: 'riya', channel: 'comments' })
    // Everything a spoofer could try to smuggle in: a viewer id under both names the wire uses,
    // and a longer expiry. The frame is built field-by-field from the attachment, so none land.
    await typing(r, sender, { type: 'typing', threadId: 't1', viewerId: 'riya', subject: 'riya', expiresAt: 1e15 })
    expect(frames(peer)).toEqual([
      { channel: 'comments', type: 'typing', viewerId: 'userA', threadId: 't1', expiresAt: expect.any(Number) },
    ])
    expect(frames(peer)[0].expiresAt).toBeLessThan(1e15)
  })

  test('C18 ATTACK: typing on an expired attachment is dropped and the socket closed', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: peer } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    // One second past its token's exp — the state a 300s token reaches on its own.
    reattach(sender, { subject: 'userA', owner: 'siteA', exp: nowSec() - 1 })
    await typing(r, sender, { type: 'typing', threadId: 't1' })
    expect(peer.sent).toEqual([])
    expect(sender.closed).toEqual([{ code: 1008, reason: expect.any(String) }])
  })

  test('an expired PEER is closed rather than delivered to — the wall holds on the receive side too', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: stale } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    const { ws: live } = await subscribe(r, { viewerId: 'userC', channel: 'comments' })
    reattach(stale, { subject: 'userB', owner: 'siteA', exp: nowSec() - 1 })
    await typing(r, sender, { type: 'typing', threadId: 't1' })
    expect(stale.sent).toEqual([])
    expect(stale.closed).toEqual([{ code: 1008, reason: expect.any(String) }])
    // …and one dropped peer does not cost the rest of the site its frame.
    expect(live.sent).toHaveLength(1)
  })

  test('C19: an unknown inbound type still changes nothing and closes nothing — two known types is not default-allow', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: peer } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    const before = sender.deserializeAttachment()
    for (const m of [
      { type: 'presence', threadId: 't1' },
      { type: 'typing' }, // known type, no threadId: still not a message this room understands
      { type: 'typing', threadId: 42 },
      { threadId: 't1' },
    ]) {
      await typing(r, sender, m)
    }
    await r.room.webSocketMessage(sender as never, 'not json at all')
    expect([sender.sent, peer.sent]).toEqual([[], []])
    expect([sender.closed, peer.closed]).toEqual([[], []])
    expect(sender.deserializeAttachment()).toEqual(before)
  })

  // C20 (no setTimeout/setInterval added by this path) is pinned by '#2: no file under src/realtime
  // uses setTimeout/setInterval' at the top of this file — it reads every non-test .ts in this
  // directory, so it covers the typing path the moment it lands. Expiry is on the wire instead.

  // The client sends this on blur, submit and cancel. Until it was handled here it woke the room and
  // did NOTHING — the exact per-message cost the 15s rate cap exists to avoid, paid for a no-op.
  test('typing.stop fans out an already-elapsed expiry, so the peer drops the indicator at once', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: peer } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })

    await typing(r, sender, { type: 'typing.stop', threadId: 't1' })

    // Same shape as a ping — the receiver has ONE code path, and `expiresAt: 0` is what "over" is.
    expect(frames(peer)).toEqual([{ channel: 'comments', type: 'typing', viewerId: 'userA', threadId: 't1', expiresAt: 0 }])
    expect([sender.sent, sender.closed, peer.closed]).toEqual([[], [], []])
  })

  // The TTL is the whole feature on the receiving side: at 1ms the indicator expires before it can
  // paint, and every assertion above (`expiresAt > before`) still passes.
  test('a ping is good for a WHILE — the TTL is a real duration, not an epsilon', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: peer } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    const before = Date.now()

    await typing(r, sender, { type: 'typing', threadId: 't1' })

    // Long enough to survive a slow keystroke, short enough that a closed laptop clears quickly.
    const ttl = frames(peer)[0].expiresAt - before
    expect(ttl).toBeGreaterThanOrEqual(10_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })

  // The third copy of the site wall (subscribe and selectRecipients have the other two, each with
  // its own test). A peer holding a token for ANOTHER site is an IDOR, not a routing accident.
  test('a peer whose attachment names another site is closed, not delivered to', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: foreign } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    const { ws: live } = await subscribe(r, { viewerId: 'userC', channel: 'comments' })
    reattach(foreign, { subject: 'userB', owner: 'siteB', exp: nowSec() + 300 })

    await typing(r, sender, { type: 'typing', threadId: 't1' })

    expect(foreign.sent).toEqual([])
    expect(foreign.closed).toEqual([{ code: 1008, reason: expect.any(String) }])
    expect(live.sent).toHaveLength(1)
  })

  // Parity with the db path's own spec ('a socket whose send() throws is closed and does not stop
  // delivery to the rest'): without the try/catch, one dead peer aborts the loop for everyone after
  // it — and which peers those are is just iteration order, so the loss would be invisible.
  test('a peer whose send() throws is closed and does not cost the rest of the site its frame', async () => {
    const r = makeRoom('siteA')
    const { ws: sender } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const { ws: dead } = await subscribe(r, { viewerId: 'userB', channel: 'comments' })
    const { ws: live } = await subscribe(r, { viewerId: 'userC', channel: 'comments' })
    dead.failNextSend(new Error('socket gone'))

    await typing(r, sender, { type: 'typing', threadId: 't1' })

    expect(dead.closed).toEqual([{ code: 1011, reason: expect.any(String) }])
    expect(live.sent).toHaveLength(1)
  })
})

describe('SiteRoom — deploy wiring', () => {
  test('contract: the request notifySiteRoom sends is the one SiteRoom.fetch accepts', async () => {
    const r = makeRoom('siteA')
    const { ws } = await subscribe(r, { viewerId: 'userA' })
    const names: string[] = []
    const env = {
      DATA_TOKEN_SECRET: HMAC,
      SITE_ROOM: {
        idFromName(name: string) {
          names.push(name)
          return { name }
        },
        get: () => ({ fetch: (input: string, init?: RequestInit) => r.room.fetch(new Request(input, init)) }),
      },
    }
    const res = await notifySiteRoom(env as never, event({ seq: 5, createdBy: 'userA' }))
    // The room is keyed by siteId — the value inside the verified token — on BOTH sides.
    expect(names).toEqual(['siteA'])
    expect(res).toBeUndefined()
    expect(frames(ws)).toHaveLength(1)
  })

  test('#1: index.ts exports SiteRoom (the wrangler class_name binding resolves by export name)', async () => {
    const mod = (await import('../index')) as { SiteRoom?: unknown }
    expect(mod.SiteRoom).toBe(SiteRoom)
  })
})

describe('SiteRoom — comment deploy wiring', () => {
  // No executionCtx in this harness (there is no real Worker request) — the same fallback
  // fireAndForget takes in prod when a caller has none: catch the access, await inline.
  const fakeCtx = (env: unknown) =>
    ({
      env,
      get executionCtx(): never {
        throw new Error('no executionCtx in test')
      },
    }) as never

  test('contract: the request notifyCommentRoom sends is the one SiteRoom.fetch\'s broadcast-comment accepts', async () => {
    const r = makeRoom('siteA')
    const { ws } = await subscribe(r, { viewerId: 'userA', channel: 'comments' })
    const names: string[] = []
    const env = {
      SITE_ROOM: {
        idFromName(name: string) {
          names.push(name)
          return { name }
        },
        get: () => ({ fetch: (input: string, init?: RequestInit) => r.room.fetch(new Request(input, init)) }),
      },
    }
    const res = await notifyCommentRoom(env as never, commentEvent())
    // Same key as the write side and the subscribe side — siteId — or one site splits across two rooms.
    expect(names).toEqual(['siteA'])
    expect(res).toBeUndefined()
    expect(ws.sent).toHaveLength(1)
  })

  test('SITE_ROOM unbound: notifyCommentRoom resolves without touching `ns.get`, notifyCommentEvent never throws', async () => {
    const env = { SITE_ROOM: undefined }
    // Direct call — nothing here swallows a throw, so this is the assertion the `if (!ns) return`
    // guard actually has to earn. Without it, `ns.get` on undefined throws and this rejects.
    await expect(notifyCommentRoom(env as never, commentEvent())).resolves.toBeUndefined()
    await expect(notifyCommentEvent(fakeCtx(env), commentEvent())).resolves.toBeUndefined()
  })

  test('a rejecting DO stub: the returned promise still resolves, the error never escapes', async () => {
    const env = {
      SITE_ROOM: {
        idFromName: () => ({}),
        get: () => ({ fetch: () => Promise.reject(new Error('boom')) }),
      },
    }
    await expect(notifyCommentEvent(fakeCtx(env), commentEvent())).resolves.toBeUndefined()
  })

  test('undefined event: no stub fetch at all — nothing to push, inventing one would be a phantom', async () => {
    let getCalls = 0
    const env = {
      SITE_ROOM: {
        idFromName: () => ({}),
        get: () => {
          getCalls += 1
          return { fetch: () => Promise.resolve(new Response(null, { status: 204 })) }
        },
      },
    }
    await notifyCommentEvent(fakeCtx(env), undefined)
    expect(getCalls).toBe(0)
  })

  test('happy path: the stub is fetched exactly once, POST /broadcast-comment, event as JSON body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const names: string[] = []
    const env = {
      SITE_ROOM: {
        idFromName(name: string) {
          names.push(name)
          return { name }
        },
        get: () => ({
          fetch: (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return Promise.resolve(new Response(null, { status: 204 }))
          },
        }),
      },
    }
    const e = commentEvent({ siteId: 'siteB' })
    await notifyCommentEvent(fakeCtx(env), e)
    expect(names).toEqual(['siteB'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://site-room/broadcast-comment')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual(e)
  })
})
