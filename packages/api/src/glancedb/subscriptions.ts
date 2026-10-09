// The glance.db subscription core: registry, replay and dispatch, with the transport INJECTED.
//
// It lives apart from client.ts on purpose. client.ts is browser code excluded from the worker
// tsconfig and unreachable from bun (DOM globals, a real socket, a real fetch); everything that
// can actually be wrong about a subscription — which callback fires, what it is handed, what
// happens after a reconnect — is decided here, where it is typechecked and unit-testable.
//
// TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE:
//   • No silent staleness. Cloudflare terminates every WebSocket when a Durable Object shuts down,
//     INCLUDING on every code deploy, so "resubscribe on reconnect" alone is at-most-once delivery
//     wearing a subscription API's clothes. Each (re)open replays the window from the last cursor
//     before any live frame is allowed through.
//   • No position leak. Cursors are opaque and never reach a callback; a page callback sees the
//     event and nothing else (constraint #9).

/** One change, exactly as the server describes it — a live push and a replayed event are the same
 *  bytes, so a page cannot tell them apart. `id` is the docId. There is deliberately no document
 *  BODY here: the change_log records that a document changed, not what it became, and hydrating
 *  every event would make the push a third read path (and a fetch per replayed row). A page that
 *  wants the contents calls `get(id)`. */
export type ChangeEvent = {
  type: 'create' | 'update' | 'delete'
  collection: string
  id: string
  createdBy: string
  at: string
}

/** A server frame: the events, plus the caller's new sealed position. `more` appears only on a
 *  catch-up reply and means the server stopped at its page limit, not at the head — the cursor
 *  has already advanced past every row it scanned, so a client that does not ask again leaves
 *  the rest of the backlog unrequested forever. */
export type Frame = { events: ChangeEvent[]; cursor: string; more?: boolean }

export type StreamHandlers = {
  /** The stream is live — first connect, or re-established after a drop. Both mean "replay". */
  onOpen: () => void
  onFrame: (f: Frame) => void
}

/** Everything the core needs from a realm. The trusted origin opens a socket itself; a hosted page
 *  has no credential and relays through the parent broker — neither difference is visible here. */
export type Transport = {
  open: (h: StreamHandlers) => void
  catchUp: (cursor: string | null) => Promise<Frame>
  /** Tear the stream down — called when the LAST listener unsubscribes. Without this the socket,
   *  its keepalive and its re-auth timer outlive every callback that justified them, for as long
   *  as the page stays open. A transport must be re-openable afterwards: subscribing again calls
   *  `open` a second time. */
  close?: () => void
}

type Listener = { collection: string; type: ChangeEvent['type']; cb: (e: ChangeEvent) => void }

/** Bounds the replay-dedupe memory. Replay pages arrive oldest-first, so the newest 500 events —
 *  the only ones a live frame buffered during the replay can duplicate — are always still in the
 *  window, however many pages deep the backlog was. */
const SEEN_LIMIT = 500

/** Identity of a single committed change. The cursor cannot be used for this — it is encrypted,
 *  so the page cannot compare two of them; that opacity is the point. (site, collection, docId,
 *  type, timestamp) is what a change_log row IS, and two rows that collide on all five are
 *  indistinguishable to a page anyway.) */
const keyOf = (e: ChangeEvent) => `${e.type}|${e.collection}|${e.id}|${e.at}`

export function createSubscriptions(transport: Transport) {
  const listeners = new Set<Listener>()
  const seen = new Set<string>()
  const order: string[] = []
  let opened = false
  let cursor: string | null = null
  // Frames that arrived while a catch-up was in flight. Without this queue the join race delivers
  // the newest event first and then "replays" older ones behind it — or drops the window entirely.
  let queued: Frame[] | null = null

  function dispatch(e: ChangeEvent): void {
    // A copy: a callback may unsubscribe (its own handler or another) mid-dispatch.
    // oxlint-disable-next-line unicorn/no-useless-spread -- the copy is the point; `listeners` is a Set being mutated during this loop
    for (const l of [...listeners]) {
      if (l.collection !== e.collection || l.type !== e.type) continue
      try {
        l.cb(e)
      } catch {
        // One page's broken handler must not cost the others their event.
      }
    }
  }

  function apply(f: Frame): void {
    for (const e of f.events) {
      const k = keyOf(e)
      if (seen.has(k)) continue
      seen.add(k)
      order.push(k)
      if (order.length > SEEN_LIMIT) {
        const evicted = order.shift() as string
        seen.delete(evicted)
      }
      dispatch(e)
    }
    cursor = f.cursor
  }

  function drain(): void {
    const pending = queued ?? []
    queued = null
    for (const f of pending) apply(f)
  }

  /** Replay from the last cursor all the way to the head. The server bounds each page, so a
   *  backlog wider than one page arrives as several: stopping after the first would leave every
   *  row beyond it unrequested — the returned cursor has already advanced past them — and the
   *  page would be silently, permanently stale. Terminates because each page's cursor advances
   *  past every row the server scanned, so `more` can only stay true while rows remain. */
  async function replay(): Promise<void> {
    for (;;) {
      const f = await transport.catchUp(cursor)
      apply(f)
      if (!f.more) return
    }
  }

  function onOpen(): void {
    queued = []
    // A failed catch-up is a missed window, not a dead stream: keep delivering, and the next
    // reconnect resumes from the last cursor that landed (a mid-backlog failure keeps the pages
    // already applied and re-asks for the rest).
    replay().then(drain, drain)
  }

  return {
    /** Register one callback. Returns its unsubscribe. The stream is opened lazily on the first
     *  subscription — a page that never listens never costs a socket. */
    on(collection: string, type: ChangeEvent['type'], cb: (e: ChangeEvent) => void): () => void {
      const l: Listener = { collection, type, cb }
      listeners.add(l)
      if (!opened) {
        opened = true
        transport.open({ onOpen, onFrame: (f) => (queued ? queued.push(f) : apply(f)) })
      }
      return () => {
        listeners.delete(l)
        // Last one out closes the stream. `opened` resets with it, so a later subscribe dials
        // again rather than listening to a socket nobody kept.
        if (listeners.size === 0 && opened) {
          opened = false
          queued = null
          transport.close?.()
        }
      }
    },
  }
}
