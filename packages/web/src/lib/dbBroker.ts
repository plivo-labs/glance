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

const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/
const DOCID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const NEEDS_DOC_ID = new Set(['get', 'put', 'delete'])
const NEEDS_DATA = new Set(['create', 'put'])
const OPS = new Set(['create', 'get', 'list', 'put', 'delete'])
const OP_METHOD: Record<string, string> = { create: 'POST', get: 'GET', list: 'GET', put: 'PUT', delete: 'DELETE' }
// Pre-check only — the server's 100KB byte cap is authoritative.
const MAX_DATA_CHARS = 110_000
const TOKEN_SLACK_MS = 30_000

export type BrokerSite = { spaceSlug: string; siteSlug: string }
type MintResponse = { token: string; caps: string[]; expiresIn: number }
type BrokerRequest = { id: number; op: string; collection: string; docId?: string; data?: unknown }

export type DbBroker = { onWindowMessage: (e: MessageEvent) => void; dispose: () => void }

export function createDbBroker(
  opts: { site: BrokerSite; contentOrigin: string; getSource: () => Window | null | undefined },
  deps: { fetchFn: typeof fetch } = { fetchFn: (...args) => fetch(...args) },
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

  async function execute(req: BrokerRequest): Promise<{ ok: boolean; status: number; body: unknown }> {
    const bad = validate(req)
    if (bad) return { ok: false, status: 400, body: { error: bad } }
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
    let res = await call(await ensureToken())
    if (res.status === 401) {
      // Token aged out or access changed — one fresh mint decides which.
      res = await call(await mint())
    }
    const body = res.status === 204 ? null : await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  }

  function validate(req: BrokerRequest): string | null {
    if (!OPS.has(req.op)) return 'unknown operation'
    if (typeof req.collection !== 'string' || !COLLECTION_RE.test(req.collection)) return 'invalid collection'
    if (NEEDS_DOC_ID.has(req.op) && (typeof req.docId !== 'string' || !DOCID_RE.test(req.docId))) return 'invalid id'
    if (NEEDS_DATA.has(req.op) && JSON.stringify(req.data ?? null).length > MAX_DATA_CHARS) return 'document too large'
    return null
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
      port?.close()
      port = null
      token = null
    },
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
  const broker = createDbBroker(opts)
  window.addEventListener('message', broker.onWindowMessage)
  return {
    dispose() {
      window.removeEventListener('message', broker.onWindowMessage)
      broker.dispose()
    },
  }
}
