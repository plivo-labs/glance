// Parent-frame credential broker for glance.db — the P0-1 (confused deputy) fix that lets
// UNTRUSTED hosted pages use the data plane without ever holding a credential.
//
// Protocol: the SDK injected into the iframe posts {type:'glance:db-hello'} with a transferred
// MessagePort. We adopt the port ONLY when the message comes from the content origin AND from
// the exact iframe window we mounted (same validation discipline as parseIntent). Every
// subsequent request arrives on that port, is shape-validated, executed with OUR token against
// /api/_data, and answered with data only — the bearer token never crosses into the iframe.
//
// Trust model: a hostile hosted page can ask us to read/write ITS OWN site's data as the
// current viewer — that is the feature, bounded server-side by caps + per-creator isolation.
// What it can NOT do: name another site (we bind every request to the site the viewer opened),
// steal the token (never sent), or reach any other API route (op → fixed path template, no raw
// paths cross the channel).
//
// Realtime works the same way: the iframe holds no credential, so WE open the WebSocket with OUR
// token and relay each pushed frame down the same port as {type:'glance:db-event'} — deliberately
// with no numeric `id`, because the SDK settles any numbered frame as a reply to an in-flight
// request. The socket outlives the iframe document, so an in-site navigation resumes from the
// cursor we kept rather than replaying from nothing.

const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/
const DOCID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const NEEDS_DOC_ID = new Set(['get', 'put', 'delete'])
const NEEDS_DATA = new Set(['create', 'put'])
// Stream ops address the site's room, not a collection — they carry a cursor and nothing else.
const STREAM_OPS = new Set(['subscribe', 'unsubscribe'])
const OPS = new Set(['create', 'get', 'list', 'put', 'delete', 'subscribe', 'unsubscribe'])
const OP_METHOD: Record<string, string> = { create: 'POST', get: 'GET', list: 'GET', put: 'PUT', delete: 'DELETE' }
// Pre-check only — the server's 100KB byte cap is authoritative.
const MAX_DATA_CHARS = 110_000
const TOKEN_SLACK_MS = 30_000
const WS_PROTOCOL = 'glance.db.v1'
const RECONNECT_MS = 3000
const RECONNECT_MAX_MS = 60_000
const PING_MS = 30_000

/** Exponential backoff with half-range jitter. The jitter matters: a deploy restarts every
 *  Durable Object at once, so without it every open tab redials in lockstep. */
export function reconnectDelay(attempt: number, base = RECONNECT_MS): number {
  const full = Math.min(base * 2 ** Math.min(attempt, 30), RECONNECT_MAX_MS)
  return full / 2 + Math.random() * (full / 2)
}

export type BrokerSite = { spaceSlug: string; siteSlug: string }
/** Only what the relay uses — so a test can stand in for a real socket. */
export type BrokerSocket = {
  send: (data: string) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: (() => void) | null
}
type MintResponse = { token: string; caps: string[]; expiresIn: number }
type BrokerRequest = { id: number; op: string; collection: string; docId?: string; data?: unknown; cursor?: string }

export type DbBroker = { onWindowMessage: (e: MessageEvent) => void; dispose: () => void }

export function createDbBroker(
  opts: { site: BrokerSite; contentOrigin: string; appOrigin: string; getSource: () => Window | null | undefined },
  deps: {
    fetchFn: typeof fetch
    newSocket: (url: string, protocols: string[]) => BrokerSocket
    reconnectBaseMs?: number
  } = {
    fetchFn: (...args) => fetch(...args),
    newSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as BrokerSocket,
  },
): DbBroker {
  let port: MessagePort | null = null
  let token: string | null = null
  let expiresAt = 0

  async function mint(): Promise<string> {
    const res = await deps.fetchFn(`/api/data-token/${opts.site.spaceSlug}/${opts.site.siteSlug}`, { method: 'POST' })
    if (!res.ok) {
      token = null
      throw Object.assign(new Error(mintError(res.status)), { status: res.status })
    }
    const data = (await res.json()) as MintResponse
    token = data.token
    expiresAt = Date.now() + data.expiresIn * 1000 - TOKEN_SLACK_MS
    return data.token
  }

  const ensureToken = () => (token && Date.now() < expiresAt ? Promise.resolve(token) : mint())

  /** One request, with exactly one re-mint if the token aged out or access changed. */
  async function withToken(run: (t: string) => Promise<Response>): Promise<Response> {
    const res = await run(await ensureToken())
    return res.status === 401 ? run(await mint()) : res
  }

  async function execute(req: BrokerRequest): Promise<{ ok: boolean; status: number; body: unknown }> {
    const bad = validate(req)
    if (bad) return { ok: false, status: 400, body: { error: bad } }
    if (req.op === 'subscribe') return subscribe(req)
    if (req.op === 'unsubscribe') {
      closeStream()
      return { ok: true, status: 200, body: null }
    }
    const path =
      req.docId !== undefined
        ? `/api/_data/${req.collection}/${encodeURIComponent(req.docId)}`
        : `/api/_data/${req.collection}`
    const call = async (t: string) =>
      deps.fetchFn(path, {
        method: OP_METHOD[req.op],
        headers: NEEDS_DATA.has(req.op)
          ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${t}` },
        body: NEEDS_DATA.has(req.op) ? JSON.stringify(req.data) : undefined,
        credentials: 'omit',
      })
    const res = await withToken(call)
    const body = res.status === 204 ? null : await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  }

  function validate(req: BrokerRequest): string | null {
    if (!OPS.has(req.op)) return 'unknown operation'
    if (STREAM_OPS.has(req.op))
      return req.cursor === undefined || typeof req.cursor === 'string' ? null : 'invalid cursor'
    if (typeof req.collection !== 'string' || !COLLECTION_RE.test(req.collection)) return 'invalid collection'
    if (NEEDS_DOC_ID.has(req.op) && (typeof req.docId !== 'string' || !DOCID_RE.test(req.docId))) return 'invalid id'
    if (NEEDS_DATA.has(req.op) && JSON.stringify(req.data ?? null).length > MAX_DATA_CHARS) return 'document too large'
    return null
  }

  // --- realtime relay -----------------------------------------------------------------------

  let socket: BrokerSocket | null = null
  // Non-null once the page has asked for a stream; resolves on the first live socket. Nulling it
  // is what stops the redial loop.
  let live: Promise<void> | null = null
  let markLive: (() => void) | null = null
  // Rejecting `live` is how a terminal dial failure reaches the page instead of hanging it.
  let failLive: ((err: unknown) => void) | null = null
  let dials = 0
  let attempts = 0
  let cursor: string | null = null
  let reauth: ReturnType<typeof setTimeout> | null = null
  let ping: ReturnType<typeof setInterval> | null = null
  let resume: (() => void) | null = null
  let disposed = false

  /** Catch up over HTTP, but only once the socket is LIVE: read the log first and any change
   *  committed between the read and the upgrade is lost by both paths. */
  async function subscribe(req: BrokerRequest): Promise<{ ok: boolean; status: number; body: unknown }> {
    if (!live) {
      live = new Promise<void>((resolve, reject) => {
        markLive = resolve
        failLive = reject
      })
      // A terminal failure with no subscribe in flight must not surface as an unhandled rejection.
      live.catch(() => {})
      dial()
    }
    try {
      await live
    } catch (err) {
      const e = err as { status?: number; message?: string } | null
      return { ok: false, status: e?.status ?? 0, body: { error: e?.message ?? 'stream unavailable' } }
    }
    // The page's own cursor wins; ours is the fallback that survives an in-site navigation.
    const from = req.cursor ?? cursor
    const q = from ? `?cursor=${encodeURIComponent(from)}` : ''
    const res = await withToken((t) =>
      deps.fetchFn(`/api/_data/_sync/changes${q}`, { headers: { Authorization: `Bearer ${t}` }, credentials: 'omit' }),
    )
    const body = (await res.json().catch(() => null)) as { cursor?: unknown } | null
    if (res.ok && typeof body?.cursor === 'string') cursor = body.cursor
    return { ok: res.ok, status: res.status, body }
  }

  function dial(): void {
    dials++
    ensureToken().then((t) => {
      if (disposed || !live) return
      // Browsers cannot set Authorization on a WebSocket, so the token rides the subprotocol list.
      const ws = deps.newSocket(`${opts.appOrigin.replace(/^http/, 'ws')}/api/_data/_sync/socket`, [WS_PROTOCOL, t])
      socket = ws
      scheduleReauth()
      ping = setInterval(() => socket === ws && ws.send('ping'), PING_MS)
      ws.onopen = () => {
        attempts = 0
        markLive?.()
        // Any dial past the first means the page missed a window: tell it to replay. The first
        // one needs no nudge — the subscribe that started it is still awaiting this moment.
        if (dials > 1) port?.postMessage({ type: 'glance:db-open' })
      }
      ws.onmessage = (e) => {
        const f = parseFrame(e.data)
        if (!f) return
        cursor = f.cursor
        port?.postMessage({ type: 'glance:db-event', events: f.events, cursor: f.cursor })
      }
      ws.onclose = () => {
        if (socket !== ws) return
        socket = null
        redial()
      }
    }, redial)
  }

  function redial(err?: unknown): void {
    if (ping) clearInterval(ping)
    ping = null
    if (disposed || !live) return
    const status = (err as { status?: number } | null)?.status
    if (status === 401 || status === 403) {
      // The session is gone or access was revoked — no amount of redialing mints past that, and a
      // forgotten tab retrying every 3s costs ~29k requests/day (the 2026-08-11 near-cap day).
      // Fail the stream and stop; only a fresh subscribe (re-login, navigation) dials again.
      const fail = failLive
      closeStream()
      fail?.(err)
      return
    }
    setTimeout(
      () => {
        if (disposed || !live) return
        if (typeof document !== 'undefined' && document.hidden) {
          // A hidden tab has no reader — park until it is visible instead of dialing blind.
          const onVisible = () => {
            if (document.hidden) return
            document.removeEventListener('visibilitychange', onVisible)
            resume = null
            if (!disposed && live) dial()
          }
          resume = onVisible
          document.addEventListener('visibilitychange', onVisible)
          return
        }
        dial()
      },
      reconnectDelay(attempts++, deps.reconnectBaseMs),
    )
  }

  /** A listen-only page issues no ops, so nothing else would ever re-mint and the room would drop
   *  the socket on its first wake past `exp`. Re-authenticate in place instead. */
  function scheduleReauth(): void {
    if (reauth) clearTimeout(reauth)
    reauth = setTimeout(
      () => {
        reauth = null
        if (disposed || !socket) return
        mint().then((t) => {
          socket?.send(JSON.stringify({ type: 'auth', token: t }))
          scheduleReauth()
        }, redial)
      },
      Math.max(0, expiresAt - Date.now()),
    )
  }

  function closeStream(): void {
    live = null
    markLive = null
    failLive = null
    if (reauth) clearTimeout(reauth)
    if (ping) clearInterval(ping)
    reauth = null
    ping = null
    if (resume) {
      document.removeEventListener('visibilitychange', resume)
      resume = null
    }
    const ws = socket
    socket = null
    ws?.close()
  }

  function onPortMessage(p: MessagePort, e: MessageEvent): void {
    const req = e.data as BrokerRequest | null
    if (!req || typeof req.id !== 'number') return
    execute(req).then(
      (r) => p.postMessage({ id: req.id, ...r }),
      () => p.postMessage({ id: req.id, ok: false, status: 0, body: { error: 'network error' } }),
    )
  }

  function onWindowMessage(e: MessageEvent): void {
    if (e.origin !== opts.contentOrigin) return
    const source = opts.getSource()
    if (!source || e.source !== source) return
    if ((e.data as { type?: unknown } | null)?.type !== 'glance:db-hello') return
    const p = e.ports?.[0]
    if (!p) return
    port?.close()
    port = p
    p.onmessage = (msg) => onPortMessage(p, msg)
    // Mint eagerly so the page learns immediately whether the feature is available here.
    ensureToken().then(
      () => p.postMessage({ type: 'glance:db-ready' }),
      (err: { message?: string }) => p.postMessage({ type: 'glance:db-error', error: err?.message ?? 'unavailable' }),
    )
  }

  return {
    onWindowMessage,
    dispose() {
      disposed = true
      closeStream()
      port?.close()
      port = null
      token = null
    },
  }
}

/** A pushed frame, or nothing — the heartbeat's auto-response is not JSON. */
function parseFrame(data: unknown): { events: unknown[]; cursor: string } | null {
  if (typeof data !== 'string') return null
  try {
    const f = JSON.parse(data) as { events?: unknown; cursor?: unknown }
    return Array.isArray(f?.events) && typeof f.cursor === 'string' ? { events: f.events, cursor: f.cursor } : null
  } catch {
    return null
  }
}

function mintError(status: number): string {
  if (status === 404) return 'glance.db is not enabled on this Glance instance'
  if (status === 401) return 'not signed in'
  return 'you do not have access to this site’s data'
}

/** Wire a broker to the real window for the lifetime of a viewer. */
export function attachDbBroker(opts: {
  site: BrokerSite
  contentOrigin: string
  getSource: () => Window | null | undefined
}): { dispose: () => void } {
  // The app origin is ours — the data plane is reached by relative path, but a WebSocket URL
  // cannot be relative. Taken here so the broker itself stays free of ambient globals.
  const broker = createDbBroker({ ...opts, appOrigin: window.location.origin })
  window.addEventListener('message', broker.onWindowMessage)
  return {
    dispose() {
      window.removeEventListener('message', broker.onWindowMessage)
      broker.dispose()
    },
  }
}
