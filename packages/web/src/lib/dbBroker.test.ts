import { describe, expect, test } from 'bun:test'
import { createDbBroker } from './dbBroker'

// The broker is the P0-1 boundary: these tests attack the handshake (origin/source spoofing),
// the request surface (op/param smuggling), and the token lifecycle (401 re-mint). Ports are
// real MessageChannels; window events are plain event-shaped objects, like parseIntent.test.ts.

const CONTENT = 'https://glance-content.example.com'
const iframeWin = {} as Window
const otherWin = {} as Window
const SITE = { spaceSlug: 'sam', siteSlug: 'demo' }

type Call = { url: string; init?: RequestInit }

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { calls, fetchFn }
}

const mintOk = () => Response.json({ token: 'tok-1', caps: ['read', 'write'], expiresIn: 300 })

function makeBroker(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, source: Window = iframeWin) {
  const { calls, fetchFn } = fakeFetch(handler)
  const broker = createDbBroker({ site: SITE, contentOrigin: CONTENT, getSource: () => source }, { fetchFn })
  return { broker, calls }
}

function hello(broker: { onWindowMessage: (e: MessageEvent) => void }, over: { origin?: string; source?: unknown } = {}) {
  const ch = new MessageChannel()
  const received: unknown[] = []
  let notify: (() => void) | null = null
  ch.port1.onmessage = (e) => {
    received.push(e.data)
    notify?.()
  }
  const waitFor = (pred: (msgs: unknown[]) => boolean, ms = 500) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting; got ${JSON.stringify(received)}`)), ms)
      notify = () => {
        if (pred(received)) {
          clearTimeout(t)
          resolve()
        }
      }
      notify()
    })
  broker.onWindowMessage({
    origin: over.origin ?? CONTENT,
    source: (over.source ?? iframeWin) as Window,
    data: { type: 'glance:db-hello' },
    ports: [ch.port2],
  } as unknown as MessageEvent)
  return { port: ch.port1, received, waitFor }
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe('handshake', () => {
  test('valid hello → ready, after minting for the bound site', async () => {
    const { broker, calls } = makeBroker(mintOk)
    const h = hello(broker)
    await h.waitFor((m) => m.some((x) => (x as { type?: string }).type === 'glance:db-ready'))
    expect(calls[0].url).toBe('/api/data-token/sam/demo')
    expect(calls[0].init?.method).toBe('POST')
  })

  test('ATTACK: hello from a foreign origin is ignored', async () => {
    const { broker, calls } = makeBroker(mintOk)
    const h = hello(broker, { origin: 'https://evil.example.com' })
    await settle()
    expect(h.received).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('ATTACK: hello from a different window (right origin) is ignored', async () => {
    const { broker, calls } = makeBroker(mintOk)
    const h = hello(broker, { source: otherWin })
    await settle()
    expect(h.received).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('disabled instance (mint 404) → db-error naming the cause, no retry loop', async () => {
    const { broker } = makeBroker(() => new Response('{"error":"not found"}', { status: 404 }))
    const h = hello(broker)
    await h.waitFor((m) => m.some((x) => (x as { type?: string }).type === 'glance:db-error'))
    const err = h.received.find((x) => (x as { type?: string }).type === 'glance:db-error') as { error: string }
    expect(err.error).toContain('not enabled')
  })
})

describe('request surface', () => {
  async function ready(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const { broker, calls } = makeBroker(handler)
    const h = hello(broker)
    await h.waitFor((m) => m.some((x) => (x as { type?: string }).type === 'glance:db-ready'))
    return { ...h, calls }
  }

  test('create round-trips with the broker token, never exposing it to the page', async () => {
    const h = await ready((url) =>
      url.includes('/api/_data/')
        ? Response.json({ id: 'd1', data: { a: 1 } }, { status: 201 })
        : mintOk(),
    )
    h.port.postMessage({ id: 7, op: 'create', collection: 'notes', data: { a: 1 } })
    await h.waitFor((m) => m.some((x) => (x as { id?: number }).id === 7))
    const reply = h.received.find((x) => (x as { id?: number }).id === 7) as { ok: boolean; status: number; body: { id: string } }
    expect(reply.ok).toBe(true)
    expect(reply.status).toBe(201)
    expect(reply.body.id).toBe('d1')
    const dataCall = h.calls.find((c) => c.url.includes('/api/_data/'))
    expect(dataCall?.url).toBe('/api/_data/notes')
    expect((dataCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    // no reply message ever carries the token
    expect(JSON.stringify(h.received)).not.toContain('tok-1')
  })

  test('ATTACK: unknown op / path-smuggling collection / bad docId → 400, no fetch', async () => {
    const h = await ready(mintOk)
    h.port.postMessage({ id: 1, op: 'admin', collection: 'notes' })
    h.port.postMessage({ id: 2, op: 'list', collection: '../auth/me' })
    h.port.postMessage({ id: 3, op: 'get', collection: 'notes', docId: 'a/../../b' })
    await h.waitFor((m) => m.filter((x) => typeof (x as { id?: number }).id === 'number').length === 3)
    for (const id of [1, 2, 3]) {
      const r = h.received.find((x) => (x as { id?: number }).id === id) as { ok: boolean; status: number }
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
    }
    expect(h.calls.filter((c) => c.url.includes('/api/_data/'))).toHaveLength(0)
  })

  test('ATTACK: oversized document rejected before any network call', async () => {
    const h = await ready(mintOk)
    h.port.postMessage({ id: 9, op: 'create', collection: 'notes', data: { blob: 'x'.repeat(120_000) } })
    await h.waitFor((m) => m.some((x) => (x as { id?: number }).id === 9))
    const r = h.received.find((x) => (x as { id?: number }).id === 9) as { ok: boolean; status: number }
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(h.calls.filter((c) => c.url.includes('/api/_data/'))).toHaveLength(0)
  })

  test('401 from the data plane triggers exactly one re-mint then retry', async () => {
    let minted = 0
    let dataCalls = 0
    const h = await ready((url) => {
      if (url.startsWith('/api/data-token/')) {
        minted++
        return Response.json({ token: `tok-${minted}`, caps: ['read'], expiresIn: 300 })
      }
      dataCalls++
      return dataCalls === 1
        ? Response.json({ error: 'unauthorized' }, { status: 401 })
        : Response.json({ items: [] })
    })
    h.port.postMessage({ id: 4, op: 'list', collection: 'notes' })
    await h.waitFor((m) => m.some((x) => (x as { id?: number }).id === 4))
    const r = h.received.find((x) => (x as { id?: number }).id === 4) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(minted).toBe(2) // hello mint + the 401 re-mint
    expect(dataCalls).toBe(2)
  })
})
