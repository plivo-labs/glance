import { describe, expect, spyOn, test } from 'bun:test'
import { createCommentStream } from './commentStream'

// S8: the transport that feeds S7's applyCommentEvent. Unlike dbBroker.ts's socket half, this
// rail carries no credential the browser can refresh — the worker mints a capability-less token
// server-side and never hands it out (ruled decision) — so there is no re-auth path here, only
// close-and-redial. There is also no cursor (ruled decision 1): a reconnect can only tell the
// consumer "a gap may have happened, go re-read the list", never replay what was missed.

const APP = 'https://glance.example.com'
const SITE = { spaceSlug: 'sam', siteSlug: 'demo' }
const WS_URL = 'wss://glance.example.com/api/sites/sam/demo/comments/socket'

/** Enough of a WebSocket for the rail, plus the levers a test needs. */
class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  close() {
    this.closed = true
  }
  /** Server → rail: one pushed frame. */
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
}

function makeStream(o: { onEvent?: (e: unknown) => void; onReconnect?: () => void; reconnectMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const events: unknown[] = []
  const reconnects: number[] = []
  const stream = createCommentStream(
    { site: SITE, appOrigin: APP, onEvent: o.onEvent ?? ((e) => events.push(e)), onReconnect: o.onReconnect ?? (() => reconnects.push(1)) },
    {
      newSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols)
        sockets.push(s)
        return s
      },
      reconnectMs: o.reconnectMs ?? 5,
    },
  )
  return { stream, sockets, events, reconnects }
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

describe('createCommentStream', () => {
  test('dials the comments socket for the site immediately', () => {
    const { sockets } = makeStream()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe(WS_URL)
  })

  test('a comments frame is decoded and handed to the consumer', () => {
    const { sockets, events } = makeStream()
    const event = { type: 'thread.created', siteId: 's1', filePath: 'index.html', thread: { id: 't1' } }
    sockets[0].emit({ channel: 'comments', ...event })
    expect(events).toEqual([event])
  })

  test('a channel:"db" frame is ignored entirely', () => {
    const { sockets, events } = makeStream()
    sockets[0].emit({ channel: 'db', events: [], cursor: 'c1' })
    expect(events).toEqual([])
  })

  test('malformed JSON is ignored without throwing', () => {
    const { sockets, events } = makeStream()
    expect(() => sockets[0].onmessage?.({ data: '{not json' })).not.toThrow()
    expect(events).toEqual([])
  })

  test('a non-string payload is ignored without throwing', () => {
    const { sockets, events } = makeStream()
    expect(() => sockets[0].onmessage?.({ data: { channel: 'comments', type: 'x' } })).not.toThrow()
    expect(events).toEqual([])
  })

  test('a frame that is not an object (a JSON array, or a bare JSON scalar) is ignored without throwing', () => {
    const { sockets, events } = makeStream()
    expect(() => sockets[0].emit('[1,2,3]')).not.toThrow()
    expect(() => sockets[0].emit('null')).not.toThrow()
    expect(() => sockets[0].emit('"comments"')).not.toThrow()
    expect(events).toEqual([])
  })

  // C15 (P0): there is no cursor, so a reconnect is the ONLY signal the consumer gets that it may
  // have missed events — it must re-read the list to converge. Documented decision: onReconnect
  // does NOT fire for the first connection (mirrors dbBroker's `dials > 1`) — the consumer's own
  // initial list read already covers dial #1, so firing there would just be a redundant re-read.
  test('C15: onReconnect does not fire on the first connection', async () => {
    // Must actually open dial #1 — otherwise this passes against a `dials > 1` AND its opposite
    // (onReconnect on every open), since neither ever ran. Firing onopen is what pins the rule.
    const { sockets, reconnects } = makeStream()
    sockets[0].onopen?.()
    await tick(20)
    expect(reconnects).toEqual([])
  })

  test('C15: onReconnect fires on a redial after the socket closes', async () => {
    const { sockets, reconnects } = makeStream({ reconnectMs: 5 })
    sockets[0].onclose?.()
    const s2 = await until('redial socket', () => sockets[1])
    s2.onopen?.()
    expect(reconnects).toEqual([1])
  })

  // Without this, `setTimeout(..., 0)` passes every other redial test — and a server that closes
  // every socket immediately (no realtime binding → 503, or the gate revoking access) turns the
  // rail into a reconnect storm against the worker instead of one dial per reconnectMs.
  test('the redial WAITS reconnectMs — no new socket before the delay elapses', async () => {
    const { sockets } = makeStream({ reconnectMs: 60 })
    sockets[0].onclose?.()
    await tick(20)
    expect(sockets).toHaveLength(1)
    await until('redial socket after the delay', () => sockets[1])
  })

  test('on close, a redial is scheduled and a NEW socket is actually dialled', async () => {
    const { sockets } = makeStream({ reconnectMs: 5 })
    expect(sockets).toHaveLength(1)
    sockets[0].onclose?.()
    // Not merely "a timer was set" — a second FakeSocket must actually be constructed.
    const s2 = await until('redial socket', () => sockets[1])
    expect(s2.url).toBe(WS_URL)
    expect(s2).not.toBe(sockets[0])
  })

  test('dispose closes the live socket', () => {
    const { stream, sockets } = makeStream()
    stream.dispose()
    expect(sockets[0].closed).toBe(true)
  })

  test('after dispose, a late-arriving socket event fires no callback', () => {
    const { stream, sockets, events } = makeStream()
    stream.dispose()
    sockets[0].emit({ channel: 'comments', type: 'thread.created', siteId: 's1', filePath: 'f', thread: {} })
    expect(events).toEqual([])
  })

  // The onmessage half of "a disposed stream stays inert" is pinned above; this is the onopen half.
  // dispose() while a redial socket is still CONNECTING, then a late open, must not tell an
  // unmounted viewer to re-read its list.
  test('after dispose, a late onopen on a redial socket fires no onReconnect', async () => {
    const { stream, sockets, reconnects } = makeStream({ reconnectMs: 5 })
    sockets[0].onclose?.()
    const s2 = await until('redial socket', () => sockets[1])
    stream.dispose()
    s2.onopen?.()
    expect(reconnects).toEqual([])
  })

  test('after dispose, no redial is scheduled — no new socket is ever created', async () => {
    const { stream, sockets } = makeStream({ reconnectMs: 5 })
    stream.dispose()
    sockets[0].onclose?.()
    await tick(30)
    expect(sockets).toHaveLength(1)
  })

  test('dispose clears a PENDING redial timer — a close just before dispose does not still redial', async () => {
    const { stream, sockets } = makeStream({ reconnectMs: 5 })
    sockets[0].onclose?.() // schedules a redial timer
    stream.dispose() // must clear it before it fires
    await tick(30)
    expect(sockets).toHaveLength(1)
  })

  // The test above is satisfiable by the timer callback's own `!disposed` re-check alone, without
  // ever calling clearTimeout — that leaves "no new socket" true but the timer HANDLE still live.
  // Spying on the real clearTimeout pins the call itself, not just one of its downstream effects.
  test('dispose calls clearTimeout on the pending redial timer, not just the disposed flag', () => {
    const clearSpy = spyOn(globalThis, 'clearTimeout')
    const { stream, sockets } = makeStream({ reconnectMs: 5 })
    sockets[0].onclose?.() // schedules a redial timer
    clearSpy.mockClear()
    stream.dispose()
    expect(clearSpy).toHaveBeenCalledTimes(1)
    clearSpy.mockRestore()
  })

  test('a throwing onEvent does not stop the stream — later frames still arrive', () => {
    let calls = 0
    const { sockets } = makeStream({
      onEvent: () => {
        calls++
        throw new Error('consumer bug')
      },
    })
    const event = { type: 'thread.created', siteId: 's1', filePath: 'f', thread: {} }
    expect(() => sockets[0].emit({ channel: 'comments', ...event })).not.toThrow()
    expect(() => sockets[0].emit({ channel: 'comments', ...event })).not.toThrow()
    expect(calls).toBe(2)
  })

  test('a throwing onReconnect does not stop redials from continuing to happen', async () => {
    const { sockets } = makeStream({ reconnectMs: 5, onReconnect: () => { throw new Error('consumer bug') } })
    sockets[0].onclose?.()
    const s2 = await until('first redial', () => sockets[1])
    expect(() => s2.onopen?.()).not.toThrow()
    s2.onclose?.()
    const s3 = await until('second redial', () => sockets[2])
    expect(s3).toBeTruthy()
  })

  test('a socket that fails to construct does not break the rail — it redials instead', async () => {
    let attempts = 0
    const reconnects: number[] = []
    let opened: FakeSocket | undefined
    const stream = createCommentStream(
      { site: SITE, appOrigin: APP, onEvent: () => {}, onReconnect: () => reconnects.push(1) },
      {
        newSocket: () => {
          attempts++
          if (attempts === 1) throw new Error('WebSocket unavailable')
          opened = new FakeSocket(WS_URL, [])
          return opened
        },
        reconnectMs: 5,
      },
    )
    await until('a second attempt after the throw', () => attempts > 1)
    // A failed construction never became a connection: this is still the consumer's FIRST live
    // socket, so it must not announce itself as a reconnect and trigger a redundant list re-read.
    opened?.onopen?.()
    expect(reconnects).toEqual([])
    stream.dispose()
  })
})

// S9 needs one bit this transport already knows and no consumer can otherwise see: is a socket OPEN
// right now. The viewer drops its own post-write list refetch only while this is true — the pushed
// event is what replaces it, and a viewer that skipped the refetch with no socket would never see
// its own comment appear.
describe('createCommentStream connected()', () => {
  test('false until the socket opens, true once it does', () => {
    const { stream, sockets } = makeStream()
    expect(stream.connected()).toBe(false) // dialled, not open yet
    sockets[0].onopen?.()
    expect(stream.connected()).toBe(true)
  })

  test('false again the moment the socket closes, true again once the redial opens', async () => {
    const { stream, sockets } = makeStream({ reconnectMs: 5 })
    sockets[0].onopen?.()
    sockets[0].onclose?.()
    expect(stream.connected()).toBe(false) // the 3s redial gap is exactly when the refetch is needed
    const s2 = await until('redial socket', () => sockets[1])
    s2.onopen?.()
    expect(stream.connected()).toBe(true)
  })

  test('false after dispose, even though the socket never reported its close', () => {
    const { stream, sockets } = makeStream()
    sockets[0].onopen?.()
    stream.dispose()
    expect(stream.connected()).toBe(false)
  })
})
