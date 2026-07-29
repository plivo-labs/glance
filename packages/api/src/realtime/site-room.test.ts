import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { type DataCapability, signDataToken } from '../lib/data-token'
import { type FakeWebSocket, installWorkerSocketGlobals, makeDurableObjectState, makeWebSocket } from '../test/harness'
import type { ChangeEvent } from './change-log'
import { decodeCursor } from './cursor'
import { notifySiteRoom } from './notify'
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
  o: { viewerId: string; caps?: DataCapability[]; siteId?: string; ttlSec?: number; token?: string },
) {
  const token =
    o.token ??
    (await signDataToken(
      HMAC,
      { siteId: o.siteId ?? 'siteA', viewerId: o.viewerId, caps: o.caps ?? VIEWER },
      o.ttlSec ?? 300,
    ))
  const res = await r.room.fetch(
    new Request('https://site-room/subscribe', { headers: { Upgrade: 'websocket', [TOKEN_HEADER]: token } }),
  )
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
    expect(r.state.getTags(ws)).toEqual(['site:siteA', 'viewer:userA'])
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
