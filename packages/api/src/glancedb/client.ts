// glance.db browser client. BROWSER code — excluded from the worker tsconfig and bundled to a
// string by scripts/build-db.ts (run `bun run build:db` after editing this file).
//
// Two transports, picked from the boot global `window.__GLANCE_DB__`:
//   • same-origin ({space, site}): the page runs on the TRUSTED app origin — mint a data token
//     via the session (/api/data-token) and call /api/_data directly. Tokens are re-minted
//     before expiry and once on a 401.
//   • broker ({appOrigin}, injected into hosted pages served through the app viewer): the page
//     is UNTRUSTED, so no credential ever enters this realm. A MessageChannel handshake hands
//     port2 to the parent frame; every operation is a message the parent validates, executes
//     with ITS token, and answers with data only (P0-1: the confused-deputy fix).
//
// The global is __GLANCE_DB__, not __GLANCE__ — that one belongs to the annotate overlay.

import { WS_PROTOCOL } from '../realtime/protocol'
import type { JsonValue } from '../lib/json'
import { type ChangeEvent, type Frame, type StreamHandlers, type Transport, createSubscriptions } from './subscriptions'

type Boot = { appOrigin?: string; space?: string; site?: string }
type Pending = { resolve: (v: JsonValue) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type BrokerReq = {
  id: number
  op: string
  collection?: string
  docId?: string
  data?: unknown
  limit?: number
  cursor?: string
}

const HELLO_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 15000

const boot = (window as unknown as { __GLANCE_DB__?: Boot }).__GLANCE_DB__

// --- broker transport (hosted pages inside the app viewer) --------------------------------

let port: MessagePort | null = null
let connecting: Promise<MessagePort> | null = null
const pending = new Map<number, Pending>()
let seq = 0
// Set once the page subscribes: the parent owns the socket here and pushes frames down the port.
let stream: StreamHandlers | null = null

function settle(id: number, fn: 'resolve' | 'reject', v: JsonValue | Error): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  if (fn === 'resolve') p.resolve(v as JsonValue)
  else p.reject(v as Error)
}

function connect(appOrigin: string): Promise<MessagePort> {
  if (port) return Promise.resolve(port)
  if (connecting) return connecting
  connecting = new Promise((resolve, reject) => {
    const ch = new MessageChannel()
    const timer = setTimeout(() => {
      connecting = null
      reject(new Error('glance.db: no broker answered — open this site through the Glance app'))
    }, HELLO_TIMEOUT_MS)
    ch.port1.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; error?: string; id?: number; ok?: boolean; status?: number; body?: unknown }
      if (d?.type === 'glance:db-ready') {
        clearTimeout(timer)
        port = ch.port1
        resolve(port)
      } else if (d?.type === 'glance:db-error') {
        clearTimeout(timer)
        connecting = null
        reject(new Error(d.error || 'glance.db: broker refused the connection'))
      } else if (d?.type === 'glance:db-event') {
        // A pushed frame, NOT a reply — it carries no `id`, so it can never settle a request.
        stream?.onFrame(e.data as Frame)
      } else if (d?.type === 'glance:db-open') {
        // The parent's socket (re)connected; replay whatever the dead one missed.
        stream?.onOpen()
      } else if (typeof d?.id === 'number') {
        // The broker's reply body is untrusted input — this is the boundary the JsonValue
        // contract is asserted at, not inside brokerCall's own plumbing.
        if (d.ok) settle(d.id, 'resolve', d.body as JsonValue)
        else settle(d.id, 'reject', new Error((d.body as { error?: string })?.error || `glance: ${d.status}`))
      }
    })
    // addEventListener does NOT implicitly start a MessagePort the way `onmessage =` does — start
    // it explicitly, before the hello goes out, so no reply can arrive before we're listening.
    ch.port1.start()
    window.parent.postMessage({ type: 'glance:db-hello' }, appOrigin, [ch.port2])
  })
  return connecting
}

async function brokerCall(appOrigin: string, req: Omit<BrokerReq, 'id'>): Promise<JsonValue> {
  const p = await connect(appOrigin)
  const id = ++seq
  return new Promise<JsonValue>((resolve, reject) => {
    const timer = setTimeout(() => settle(id, 'reject', new Error('glance.db: request timed out')), REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin parameter; MessagePort is not the window.postMessage this rule targets
    p.postMessage({ id, ...req })
  })
}

// --- same-origin transport (trusted app origin) --------------------------------------------

let token: string | null = null
let expiresAt = 0

async function mint(space: string, site: string): Promise<string> {
  const r = await fetch(`/api/data-token/${space}/${site}`, { method: 'POST' })
  if (!r.ok) throw new Error(`glance: could not mint data token (${r.status})`)
  const data = (await r.json()) as { token: string; expiresIn: number }
  token = data.token
  expiresAt = Date.now() + Math.max(0, data.expiresIn - 30) * 1000
  return token
}

async function directCall(space: string, site: string, method: string, path: string, body?: unknown, retried?: boolean): Promise<JsonValue> {
  const t = token && Date.now() < expiresAt ? token : await mint(space, site)
  const res = await fetch(`/api/_data${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !retried) {
    token = null
    return directCall(space, site, method, path, body, true)
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `glance: ${res.status}`)
  return data
}

// --- realtime (same-origin transport) --------------------------------------------------------

const RECONNECT_MS = 3000
const PING_MS = 30_000

/** A socket to the site's room, re-dialled forever. Browsers cannot set `Authorization` on
 *  `new WebSocket()`, so the token rides the subprotocol list — the one channel the upgrade route
 *  reads. Every dial mints a FRESH token: a socket may not outlive the 300s that authorized it, and
 *  the room drops it on the first wake past expiry. That drop is harmless — the reconnect below
 *  replays the window from the last cursor, so nothing is lost, only re-fetched. */
function directTransport(space: string, site: string): Transport {
  // The redial loop is otherwise unstoppable — every close schedules the next dial — so a page
  // that unsubscribes everything would keep reconnecting forever. `stopped` is the only brake.
  let socket: WebSocket | null = null
  let stopped = false
  return {
    open(h) {
      stopped = false
      const url = `${location.origin.replace(/^http/, 'ws')}/api/_data/_sync/socket`
      const dial = () =>
        mint(space, site)
          .then((t) => {
            if (stopped) return
            const ws = new WebSocket(url, [WS_PROTOCOL, t])
            socket = ws
            // Answered by the runtime's auto-response, so a keepalive never wakes the room.
            const ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), PING_MS)
            ws.addEventListener('open', () => h.onOpen())
            ws.addEventListener('message', (e: MessageEvent) => {
              try {
                const f = JSON.parse(e.data as string) as Frame
                if (Array.isArray(f?.events)) h.onFrame(f)
              } catch {
                // 'pong' and anything else unparseable: not a frame.
              }
            })
            ws.addEventListener('close', () => {
              clearInterval(ping)
              if (!stopped) setTimeout(dial, RECONNECT_MS)
            })
          })
          .catch(() => {
            if (!stopped) setTimeout(dial, RECONNECT_MS)
          })
      dial()
    },
    close() {
      stopped = true
      socket?.close()
      socket = null
    },
    catchUp: (cursor) =>
      directCall(
        space,
        site,
        'GET',
        `/_sync/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ) as Promise<Frame>,
  }
}

/** Hosted pages hold no credential, so the PARENT opens the socket with its own token and relays
 *  frames over the port we already have. Catch-up is a port op for the same reason. */
function brokerTransport(appOrigin: string): Transport {
  return {
    open(h) {
      stream = h
      connect(appOrigin).then(
        () => h.onOpen(),
        () => {
          // No broker answered; nothing to listen to. The page's ops report the same failure.
        },
      )
    },
    close() {
      stream = null
      // The parent owns the socket, so only it can drop one — this is the op `dbBroker.closeStream`
      // has always implemented and nothing ever sent. Best-effort teardown (the page is already
      // gone by the time this could fail), but a failure is still information — surface it instead
      // of discarding it silently.
      void brokerCall(appOrigin, { op: 'unsubscribe' }).catch((err: unknown) => {
        console.error('glance.db: unsubscribe failed', err)
      })
    },
    catchUp: (cursor) => brokerCall(appOrigin, { op: 'subscribe', cursor: cursor ?? undefined }) as Promise<Frame>,
  }
}

let subs: ReturnType<typeof createSubscriptions> | null = null

function subscriptions() {
  if (!subs) {
    if (boot?.space && boot?.site) subs = createSubscriptions(directTransport(boot.space, boot.site))
    else if (boot?.appOrigin && window.parent !== window) subs = createSubscriptions(brokerTransport(boot.appOrigin))
    else
      throw new Error('glance.db: not connected — open this site through the Glance app, or set window.__GLANCE_DB__')
  }
  return subs
}

// --- public surface -------------------------------------------------------------------------

function call(op: string, coll: string, docId?: string, data?: unknown): Promise<JsonValue> {
  if (boot?.space && boot?.site) {
    const seg = docId !== undefined ? `/${coll}/${encodeURIComponent(docId)}` : `/${coll}`
    const method = op === 'create' ? 'POST' : op === 'put' ? 'PUT' : op === 'delete' ? 'DELETE' : 'GET'
    return directCall(boot.space, boot.site, method, seg, data)
  }
  if (boot?.appOrigin && window.parent !== window) {
    return brokerCall(boot.appOrigin, { op, collection: coll, docId, data })
  }
  return Promise.reject(
    new Error('glance.db: not connected — open this site through the Glance app, or set window.__GLANCE_DB__'),
  )
}

function collection(name: string) {
  return {
    create: (data: unknown) => call('create', name, undefined, data),
    get: (id: string) => call('get', name, id),
    list: () => call('list', name),
    put: (id: string, data: unknown) => call('put', name, id, data),
    delete: (id: string) => call('delete', name, id),
    // Each returns its own unsubscribe. A callback is handed the change, not the document: ask
    // `get(id)` for the contents. Subscriptions are keyed by collection NAME inside the core, not
    // held on this literal — `collection('x')` builds a fresh object on every call.
    onCreate: (cb: (e: ChangeEvent) => void) => subscriptions().on(name, 'create', cb),
    onUpdate: (cb: (e: ChangeEvent) => void) => subscriptions().on(name, 'update', cb),
    onDelete: (cb: (e: ChangeEvent) => void) => subscriptions().on(name, 'delete', cb),
  }
}

;(window as unknown as { glance: unknown }).glance = { db: { collection } }
