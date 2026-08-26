import { describe, expect, test } from 'bun:test'
import { createDbBroker, reconnectDelay } from './dbBroker'

/* oxlint-disable unicorn/require-post-message-target-origin -- every send here is a MessagePort, which has no targetOrigin parameter */

// The realtime half of the P0-1 boundary. A hosted page holds NO credential (the boot payload is
// exactly {appOrigin}), so it can never open its own WebSocket: the parent owns the socket, binds
// it to the site the viewer opened, and relays frames down the port the page already handed us.
// These tests attack that relay — token leakage, origin/source spoofing, site smuggling, reply-id
// collisions — and pin the two lifecycle properties a listen-only page depends on: resume after an
// in-site navigation, and re-auth before the 300s token expires.

const APP = 'https://glance.example.com'
const CONTENT = 'https://glance-content.example.com'
const iframeWin = {} as Window
const otherWin = {} as Window
const SITE = { spaceSlug: 'sam', siteSlug: 'demo' }
const WS_URL = 'wss://glance.example.com/api/_data/_sync/socket'

type Call = { url: string; init?: RequestInit }
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
// Everything the broker can post down the port: a reply (id/ok/status/body) or a
// glance:db-{ready,error,open,event} frame. Tests narrow further per assertion.
type BrokerMsg = { type?: string; id?: number; ok?: boolean; status?: number; body?: unknown; error?: string; events?: unknown[]; cursor?: string }

/** Enough of a WebSocket for the relay, plus the levers a test needs: when it opened, what the
 *  parent sent over it, and whether it was closed. */
class FakeSocket {
  private listeners: { open: ((e: { data: unknown }) => void)[]; message: ((e: { data: unknown }) => void)[]; close: ((e: { data: unknown }) => void)[] } = {
    open: [],
    message: [],
    close: [],
  }
  sent: string[] = []
  closed = false
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  addEventListener(type: 'open' | 'message' | 'close', fn: (e: { data: unknown }) => void) {
    this.listeners[type].push(fn)
  }
  /** Test-only triggers standing in for the browser dispatching the real event. */
  onopen() {
    for (const fn of this.listeners.open) fn({ data: undefined })
  }
  onclose() {
    for (const fn of this.listeners.close) fn({ data: undefined })
  }
  /** Server → parent: one pushed frame. */
  emit(frame: unknown) {
    for (const fn of this.listeners.message) fn({ data: JSON.stringify(frame) })
  }
}

const mintOk = () => Response.json({ token: 'tok-1', caps: ['read', 'create'], expiresIn: 300 })
const frame = (events: unknown[], cursor: string) => Response.json({ events, cursor })
const EVENT = { type: 'create', collection: 'notes', id: 'd1', createdBy: 'userA', at: '2026-07-01T00:00:00.000Z' }

function makeBroker(handler: Handler, source: Window = iframeWin, reconnectBaseMs?: number) {
  const calls: Call[] = []
  const sockets: FakeSocket[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  const broker = createDbBroker(
    { site: SITE, contentOrigin: CONTENT, appOrigin: APP, getSource: () => source },
    {
      fetchFn,
      newSocket: (url: string, protocols: string[]) => {
        const s = new FakeSocket(url, protocols)
        sockets.push(s)
        return s
      },
      reconnectBaseMs,
    },
  )
  return { broker, calls, sockets }
}

function hello(
  broker: { onWindowMessage: (e: MessageEvent) => void },
  over: { origin?: string; source?: unknown } = {},
) {
  const ch = new MessageChannel()
  const received: BrokerMsg[] = []
  // addEventListener does not implicitly start the port the way `onmessage =` does — start it.
  ch.port1.addEventListener('message', (e) => {
    received.push(e.data as BrokerMsg)
  })
  ch.port1.start()
  broker.onWindowMessage({
    origin: over.origin ?? CONTENT,
    source: (over.source ?? iframeWin) as Window,
    data: { type: 'glance:db-hello' },
    ports: [ch.port2],
  } as unknown as MessageEvent)
  return { port: ch.port1, received }
}

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms))

async function until<T>(what: string, pred: () => T | undefined | false, ms = 500): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = pred()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await tick(2)
  }
}

const typed = (msgs: BrokerMsg[], t: string) => msgs.filter((m) => m.type === t)
const replied = (msgs: BrokerMsg[], id: number) => msgs.find((m) => m.id === id)

/** hello → ready → the page asks for the stream. Returns once the socket exists and is open. */
async function subscribed(handler: Handler, reconnectBaseMs?: number) {
  const b = makeBroker(handler, iframeWin, reconnectBaseMs)
  const h = hello(b.broker)
  await until('ready', () => typed(h.received, 'glance:db-ready').length > 0)
  h.port.postMessage({ id: 1, op: 'subscribe' })
  const sock = await until('socket', () => b.sockets[0])
  sock.onopen?.()
  await until('subscribe reply', () => replied(h.received, 1))
  return { ...b, ...h, sock }
}

describe('broker realtime relay', () => {
  test('the parent opens the socket; no token ever crosses the MessagePort', async () => {
    const s = await subscribed((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')))
    expect(s.sockets).toHaveLength(1)
    expect(s.sock.url).toBe(WS_URL)
    // Browsers cannot set Authorization on a WebSocket; the token rides the subprotocol list.
    expect(s.sock.protocols).toEqual(['glance.db.v1', 'tok-1'])
    s.sock.emit({ events: [EVENT], cursor: 'c2' })
    await until('event', () => typed(s.received, 'glance:db-event').length > 0)
    expect(JSON.stringify(s.received)).not.toContain('tok-1')
    expect(s.received.some((m) => JSON.stringify(m).includes('Bearer'))).toBe(false)
    s.broker.dispose()
  })

  test('ATTACK: a subscribe from a spoofed origin or a foreign source window never opens a socket', async () => {
    // Control first: the SAME message over a well-formed handshake does open one, so "no socket"
    // below means the guard rejected it, not that subscribe is inert.
    const ok = await subscribed((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')))
    expect(ok.sockets).toHaveLength(1)
    ok.broker.dispose()

    for (const over of [{ origin: 'https://evil.example.com' }, { source: otherWin }]) {
      const b = makeBroker(mintOk)
      const h = hello(b.broker, over)
      h.port.postMessage({ id: 1, op: 'subscribe' })
      await tick(30)
      expect(h.received).toHaveLength(0)
      expect(b.sockets).toHaveLength(0)
      expect(b.calls).toHaveLength(0)
      b.broker.dispose()
    }
  })

  test('ATTACK: the page cannot subscribe to another site', async () => {
    const b = makeBroker((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')))
    const h = hello(b.broker)
    await until('ready', () => typed(h.received, 'glance:db-ready').length > 0)
    h.port.postMessage({ id: 1, op: 'subscribe', space: 'evil', site: 'evil', collection: '../../evil' })
    const sock = await until('socket', () => b.sockets[0])
    sock.onopen?.()
    const reply = await until('subscribe reply', () => replied(h.received, 1))
    expect(reply.ok).toBe(true)
    // The site is carried by the token the PARENT minted, and the URL has no site in it at all.
    expect(sock.url).toBe(WS_URL)
    expect(b.calls[0].url).toBe('/api/data-token/sam/demo')
    expect(b.calls.some((c) => c.url.includes('evil'))).toBe(false)
    b.broker.dispose()
  })

  test('pushed events reach the page as glance:db-event frames with NO numeric id', async () => {
    const s = await subscribed((url) => {
      if (url.startsWith('/api/data-token/')) return mintOk()
      if (url.startsWith('/api/_data/_sync/changes')) return frame([], 'c1')
      return new Promise<Response>(() => {}) // an op that never answers: it must stay pending
    })
    s.port.postMessage({ id: 42, op: 'list', collection: 'notes' })
    await tick(20)
    s.sock.emit({ events: [EVENT], cursor: 'c2' })
    const evts = await until('event', () => {
      const m = typed(s.received, 'glance:db-event')
      return m.length > 0 ? m : false
    })
    expect(evts[0]).toEqual({ type: 'glance:db-event', events: [EVENT], cursor: 'c2' })
    expect('id' in evts[0]).toBe(false)
    // The SDK settles ANY numbered frame as a reply — a pushed event must not be one.
    expect(replied(s.received, 42)).toBeUndefined()
    s.broker.dispose()
  })

  test('a frame tagged channel:"db" (new server) is handled identically to a channel-less one (old server)', async () => {
    // S1 made the server add `channel: 'db'` to the frame. This is the REAL dbBroker, not a copy —
    // it must still parse and dispatch the tagged frame exactly like the untagged one it always sent.
    const s = await subscribed((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')))
    s.sock.emit({ channel: 'db', events: [EVENT], cursor: 'c2' })
    const evts = await until('event', () => {
      const m = typed(s.received, 'glance:db-event')
      return m.length > 0 ? m : false
    })
    expect(evts[0]).toEqual({ type: 'glance:db-event', events: [EVENT], cursor: 'c2' })
    expect('channel' in evts[0]).toBe(false)
    s.broker.dispose()
  })

  test('a new glance:db-hello re-establishes subscriptions and resumes from the stored cursor', async () => {
    const changes: string[] = []
    const s = await subscribed((url) => {
      if (url.startsWith('/api/data-token/')) return mintOk()
      changes.push(url)
      return frame([], 'c1')
    })
    s.sock.emit({ events: [EVENT], cursor: 'c2' })
    await until('event', () => typed(s.received, 'glance:db-event').length > 0)

    // In-site navigation: the iframe document (and all its module state, including the cursor)
    // is destroyed and a fresh SDK says hello over a new port.
    const h2 = hello(s.broker)
    await until('ready#2', () => typed(h2.received, 'glance:db-ready').length > 0)
    h2.port.postMessage({ id: 1, op: 'subscribe' })
    await until('subscribe reply#2', () => replied(h2.received, 1))

    expect(changes).toEqual(['/api/_data/_sync/changes', '/api/_data/_sync/changes?cursor=c2'])
    expect(s.sockets).toHaveLength(1)
    // The old port is closed: nothing the dead document posts is ever answered.
    s.port.postMessage({ id: 99, op: 'list', collection: 'notes' })
    await tick(30)
    expect(replied(s.received, 99)).toBeUndefined()
    s.broker.dispose()
  })

  test('a paged catch-up is relayed whole — `more` reaches the page, and its next cursor reaches the server', async () => {
    // The SDK core is what pages (subscriptions.ts replay loop); the broker's only job is to not
    // eat the flag or the cursor on the way past. Swallowing either strands the page mid-backlog.
    const pages = [
      { events: [EVENT], cursor: 'c1', more: true },
      { events: [], cursor: 'c2', more: false },
    ]
    let n = 0
    const changes: string[] = []
    const s = await subscribed((url) => {
      if (url.startsWith('/api/data-token/')) return mintOk()
      changes.push(url)
      return Response.json(pages[n++])
    })
    expect(replied(s.received, 1)).toMatchObject({ ok: true, body: { cursor: 'c1', more: true } })

    s.port.postMessage({ id: 2, op: 'subscribe', cursor: 'c1' })
    const second = await until('page 2', () => replied(s.received, 2))
    expect(second).toMatchObject({ ok: true, body: { cursor: 'c2', more: false } })
    expect(changes).toEqual(['/api/_data/_sync/changes', '/api/_data/_sync/changes?cursor=c1'])
    // Paging is HTTP only: it must never cost a second socket.
    expect(s.sockets).toHaveLength(1)
    s.broker.dispose()
  })

  test('ATTACK: an unknown op is rejected by validate() and never opens a socket', async () => {
    const b = makeBroker(mintOk)
    const h = hello(b.broker)
    await until('ready', () => typed(h.received, 'glance:db-ready').length > 0)
    h.port.postMessage({ id: 1, op: 'connect' })
    h.port.postMessage({ id: 2, op: 'subscribe_all' })
    h.port.postMessage({ id: 3, op: 'unsubscribe' }) // control: a REAL stream op is accepted
    await until('all replies', () => replied(h.received, 1) && replied(h.received, 2) && replied(h.received, 3))
    for (const id of [1, 2]) {
      const r = replied(h.received, id) as { ok: boolean; status: number }
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
    }
    expect((replied(h.received, 3) as { ok: boolean }).ok).toBe(true)
    expect(b.sockets).toHaveLength(0)
    b.broker.dispose()
  })

  test('the broker re-mints and re-authenticates the socket before the 300s token expiry', async () => {
    // Same arithmetic as production (expiresIn − 30s slack), compressed: 30.04s − 30s = 40ms.
    let minted = 0
    const s = await subscribed((url) => {
      if (url.startsWith('/api/data-token/')) {
        minted++
        return Response.json({ token: `tok-${minted}`, caps: ['read'], expiresIn: 30.04 })
      }
      return frame([], 'c1')
    })
    expect(minted).toBe(1)
    // A listen-only page issues no further ops: nothing but the broker's own timer can save it.
    const sent = await until('re-auth', () => (s.sock.sent.length > 0 ? s.sock.sent : false), 1000)
    expect(minted).toBeGreaterThan(1)
    expect(JSON.parse(sent[0])).toEqual({ type: 'auth', token: `tok-${minted}` })
    expect(s.sock.closed).toBe(false)
    s.broker.dispose()
  })

  test('dispose closes both the socket and the port', async () => {
    const s = await subscribed((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')))
    s.broker.dispose()
    expect(s.sock.closed).toBe(true)
    s.port.postMessage({ id: 5, op: 'list', collection: 'notes' })
    await tick(30)
    expect(replied(s.received, 5)).toBeUndefined()
  })

  test('a 401 mint mid-stream KILLS the redial loop — one probe, then silence', async () => {
    // The 2026-08-11 incident: a tab whose session expired kept re-minting every 3s forever
    // (28,800 requests/day). Compressed here: the token expires in ~100ms (30.1s − 30s slack),
    // the session dies, so the broker's own re-auth mint 401s. Exactly one probe may see the
    // 401 — no timer may survive it.
    let dead = false
    let minted = 0
    const s = await subscribed((url) => {
      if (!url.startsWith('/api/data-token/')) return frame([], 'c1')
      minted++
      if (dead) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return Response.json({ token: `tok-${minted}`, caps: ['read'], expiresIn: 30.1 })
    }, 5)
    expect(minted).toBe(1)
    dead = true
    await until('the 401 probe', () => minted >= 2, 1000)
    await tick(150) // ~30 base-delay periods: a surviving loop would mint dozens more
    expect(minted).toBe(2)
    expect(s.sockets).toHaveLength(1)

    // A page that asks again gets a real answer, not a hung request — and still no loop.
    s.port.postMessage({ id: 9, op: 'subscribe' })
    const reply = (await until('terminal reply', () => replied(s.received, 9))) as { ok: boolean; status: number }
    expect(reply.ok).toBe(false)
    expect(reply.status).toBe(401)
    await tick(100)
    expect(minted).toBe(3)
    s.broker.dispose()
  })

  test('a dropped socket redials with a cached token, and backoff resets once a dial lands', async () => {
    const s = await subscribed((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')), 5)
    s.sock.onclose?.()
    const second = await until('redial', () => s.sockets[1])
    second.onopen?.()
    // The token is minutes from expiry: the redial must reuse it, not mint a fresh one.
    expect(s.calls.filter((c) => c.url.startsWith('/api/data-token/'))).toHaveLength(1)
    expect(second.protocols).toEqual(['glance.db.v1', 'tok-1'])
    s.broker.dispose()
  })

  test('reconnectDelay grows exponentially, caps at 60s, and jitters within [half, full]', () => {
    for (const [attempt, full] of [
      [0, 3000],
      [1, 6000],
      [3, 24_000],
      [10, 60_000],
      [40, 60_000], // 2**40 overflows the cap arithmetic if written naively
    ] as const) {
      for (let i = 0; i < 20; i++) {
        const d = reconnectDelay(attempt)
        expect(d).toBeGreaterThanOrEqual(full / 2)
        expect(d).toBeLessThanOrEqual(full)
      }
    }
    const base = reconnectDelay(2, 10)
    expect(base).toBeGreaterThanOrEqual(20)
    expect(base).toBeLessThanOrEqual(40)
  })

  test('a hidden tab parks the redial until the tab is visible again', async () => {
    const s = await subscribed((url) => (url.startsWith('/api/data-token/') ? mintOk() : frame([], 'c1')), 5)
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    try {
      s.sock.onclose?.()
      await tick(150)
      expect(s.sockets).toHaveLength(1) // no blind dialing in a background tab

      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      const second = await until('resume dial', () => s.sockets[1])
      second.onopen?.()
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    }
    s.broker.dispose()
  })
})
