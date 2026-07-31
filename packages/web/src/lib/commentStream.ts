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
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

const WS_PROTOCOL = 'glance.db.v1'
const RECONNECT_MS = 3000

export type CommentStream = { dispose: () => void }

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
      if (dials > 1) safely(opts.onReconnect)
    }
    ws.onmessage = (e) => {
      if (disposed) return
      const event = parseFrame(e.data)
      if (event) safely(() => opts.onEvent(event))
    }
    ws.onclose = () => {
      if (disposed || socket !== ws) return
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

  dial()

  return {
    dispose() {
      disposed = true
      if (redialTimer) clearTimeout(redialTimer)
      redialTimer = null
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
