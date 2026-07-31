import type { CommentEvent } from './applyCommentEvent'

// The comments-channel transport that feeds S7's applyCommentEvent. Shaped like dbBroker.ts's
// socket half (dial / redial / dispose, injectable socket factory) but deliberately NOT that file
// and NOT importing it: dbBroker's token lives in the browser and is refreshed in place via a
// `{type:'auth'}` message; this socket's token is minted INTERNALLY by the worker
// (GET .../comments/socket, session-cookie authenticated) and never reaches the browser, so there
// is no credential here to refresh. Every 300s the server closes the socket out from under this
// rail and the only move is to redial cold — no re-auth path, no mint endpoint, by design.
//
// There is also no cursor and no catch-up (ruled decision 1): a comment event has no seq to seal
// into a resume point, so a reconnect can never replay what was missed. The one thing this rail
// CAN do for the consumer is say "a gap may have just happened, go re-read the list" — that is
// `onReconnect`, fired on every redial past the first. It does NOT fire on the first connection:
// mirroring dbBroker's own `dials > 1` rule keeps S9's job the same shape as the db rail's —
// "read the list once on mount, then re-read it only when told a gap occurred" — rather than
// forcing every consumer to special-case dial #1.

export type CommentStreamSite = { spaceSlug: string; siteSlug: string }
/** Only what the rail uses — so a test can stand in for a real socket. */
export type CommentStreamSocket = {
  close: () => void
  send: (data: string) => void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

const WS_PROTOCOL = 'glance.db.v1'
const RECONNECT_MS = 3000
/** The whole cost control for the send half: every inbound message WAKES the Durable Object, so an
 *  uncapped keystroke stream is the bill. One ping per thread per window, no matter how fast the
 *  typing. It lives here rather than in the composer so no caller can forget it — and it is shorter
 *  than the room's TYPING_TTL_MS (20s), or a viewer who never stops typing would flicker. */
const TYPING_MIN_INTERVAL_MS = 15_000

export type CommentStream = {
  dispose: () => void
  /** Is a socket OPEN right now — read on demand, never a subscription (nothing re-renders on it).
   *  S9's consumer drops its own post-write list refetch only while this is true: the pushed event
   *  is what replaces it, so a viewer in the redial gap must keep refetching or it stops seeing its
   *  own writes. */
  connected: () => boolean
  /** "I am still typing in this thread" — call it on EVERY keystroke; the rail drops all but one
   *  per TYPING_MIN_INTERVAL_MS per thread. */
  sendTyping: (threadId: string) => void
  /** "I stopped" — blur and submit. Never rate-capped (there is at most one per compose) and never
   *  sent for a thread this rail never pinged. */
  sendTypingStop: (threadId: string) => void
}

export function createCommentStream(
  opts: { site: CommentStreamSite; appOrigin: string; onEvent: (event: CommentEvent) => void; onReconnect: () => void },
  deps: { newSocket: (url: string, protocols: string[]) => CommentStreamSocket; reconnectMs?: number } = {
    newSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as CommentStreamSocket,
  },
): CommentStream {
  const reconnectMs = deps.reconnectMs ?? RECONNECT_MS
  let disposed = false
  let socket: CommentStreamSocket | null = null
  let redialTimer: ReturnType<typeof setTimeout> | null = null
  let dials = 0
  let open = false
  /** threadId → when this rail last actually PUT a typing ping on the wire for it. */
  const lastTypingAt = new Map<string, number>()

  /** Never lets a throwing consumer callback take the socket's event loop down with it. */
  function safely(fn: () => void): void {
    try {
      fn()
    } catch {
      // consumer bug — the rail keeps running
    }
  }

  function dial(): void {
    let ws: CommentStreamSocket
    try {
      ws = deps.newSocket(
        `${opts.appOrigin.replace(/^http/, 'ws')}/api/sites/${opts.site.spaceSlug}/${opts.site.siteSlug}/comments/socket`,
        [WS_PROTOCOL],
      )
    } catch {
      // construction can throw synchronously (bad URL, no WebSocket global, ...) — same recovery
      // as a socket that opens and immediately closes.
      redial()
      return
    }
    socket = ws
    // Counted here, not at entry: a construction that throws never became a connection, so counting
    // the attempt would make the FIRST socket the consumer ever gets open report itself as a redial.
    dials++
    // Each handler re-checks `disposed`: dispose() clears our own reference and calls ws.close(),
    // but close() is not synchronous delivery — a late event or close callback can still land on
    // this closure afterward, and a disposed stream must stay inert for it (case 5).
    ws.onopen = () => {
      if (disposed) return
      open = true
      if (dials > 1) safely(opts.onReconnect)
    }
    ws.onmessage = (e) => {
      if (disposed) return
      const event = parseFrame(e.data)
      if (event) safely(() => opts.onEvent(event))
    }
    ws.onclose = () => {
      if (disposed || socket !== ws) return
      open = false
      socket = null
      redial()
    }
  }

  function redial(): void {
    if (disposed) return
    redialTimer = setTimeout(() => {
      redialTimer = null
      if (!disposed) dial()
    }, reconnectMs)
  }

  /** One frame out, or nothing. There is no queue: the socket is closed for the whole redial gap
   *  (and the 300s server-side close is routine), and a typing ping is worthless by the time a
   *  later socket could flush it — buffering keystrokes would only grow without bound and then
   *  deliver a lie. Returns whether the frame actually left. */
  function post(frame: object): boolean {
    if (disposed || !open || !socket) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      // A socket that rejects a send is already gone — onclose (and the redial) handles it.
      return false
    }
  }

  dial()

  return {
    connected: () => open,
    sendTyping(threadId) {
      const now = Date.now()
      const last = lastTypingAt.get(threadId)
      if (last !== undefined && now - last < TYPING_MIN_INTERVAL_MS) return
      // The window opens only on a ping that was really SENT: a keystroke swallowed by a closed
      // socket must not silence the first one that could have gone out.
      if (post({ type: 'typing', threadId })) lastTypingAt.set(threadId, now)
    },
    sendTypingStop(threadId) {
      // Nothing was ever announced for this thread (a composer opened and abandoned without a
      // keystroke), so there is nothing to take back — and waking the object to say so is exactly
      // the cost this slice exists to avoid.
      if (!lastTypingAt.delete(threadId)) return
      post({ type: 'typing.stop', threadId })
    },
    dispose() {
      disposed = true
      open = false
      if (redialTimer) clearTimeout(redialTimer)
      redialTimer = null
      lastTypingAt.clear()
      const ws = socket
      socket = null
      ws?.close()
    },
  }
}

/** A comments-channel frame, or nothing — anything malformed, non-object, or tagged for the OTHER
 *  channel (`db`) must be silently dropped: a hostile or buggy server frame must never throw. */
function parseFrame(data: unknown): CommentEvent | null {
  if (typeof data !== 'string') return null
  let f: unknown
  try {
    f = JSON.parse(data)
  } catch {
    return null
  }
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return null
  const { channel, ...rest } = f as { channel?: unknown }
  return channel === 'comments' ? (rest as CommentEvent) : null
}
