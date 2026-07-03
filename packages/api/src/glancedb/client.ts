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

type Boot = { appOrigin?: string; space?: string; site?: string }
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type BrokerReq = { id: number; op: string; collection: string; docId?: string; data?: unknown; limit?: number }

const HELLO_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 15000

const boot = (window as unknown as { __GLANCE_DB__?: Boot }).__GLANCE_DB__

// --- broker transport (hosted pages inside the app viewer) --------------------------------

let port: MessagePort | null = null
let connecting: Promise<MessagePort> | null = null
const pending = new Map<number, Pending>()
let seq = 0

function settle(id: number, fn: 'resolve' | 'reject', v: unknown): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  if (fn === 'resolve') p.resolve(v)
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
    ch.port1.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; error?: string; id?: number; ok?: boolean; status?: number; body?: unknown }
      if (d?.type === 'glance:db-ready') {
        clearTimeout(timer)
        port = ch.port1
        resolve(port)
      } else if (d?.type === 'glance:db-error') {
        clearTimeout(timer)
        connecting = null
        reject(new Error(d.error || 'glance.db: broker refused the connection'))
      } else if (typeof d?.id === 'number') {
        if (d.ok) settle(d.id, 'resolve', d.body)
        else settle(d.id, 'reject', new Error((d.body as { error?: string })?.error || `glance: ${d.status}`))
      }
    }
    window.parent.postMessage({ type: 'glance:db-hello' }, appOrigin, [ch.port2])
  })
  return connecting
}

async function brokerCall(appOrigin: string, req: Omit<BrokerReq, 'id'>): Promise<unknown> {
  const p = await connect(appOrigin)
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(id, 'reject', new Error('glance.db: request timed out')), REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
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

async function directCall(space: string, site: string, method: string, path: string, body?: unknown, retried?: boolean): Promise<unknown> {
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

// --- public surface -------------------------------------------------------------------------

function call(op: string, collection: string, docId?: string, data?: unknown): Promise<unknown> {
  if (boot?.space && boot?.site) {
    const seg = docId !== undefined ? `/${collection}/${encodeURIComponent(docId)}` : `/${collection}`
    const method = op === 'create' ? 'POST' : op === 'put' ? 'PUT' : op === 'delete' ? 'DELETE' : 'GET'
    return directCall(boot.space, boot.site, method, seg, data)
  }
  if (boot?.appOrigin && window.parent !== window) {
    return brokerCall(boot.appOrigin, { op, collection, docId, data })
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
  }
}

;(window as unknown as { glance: unknown }).glance = { db: { collection } }
