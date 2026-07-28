import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { GLANCE_DB_JS, GLANCE_DB_VERSION } from './bundle'
import { type ChangeEvent, type Frame, type StreamHandlers, createSubscriptions } from './subscriptions'

// The SDK's subscription core, exercised against a fake transport: no DOM, no socket, no fetch.
// Everything the page-facing contract promises (per-collection routing, per-type dispatch,
// unsubscribe, catch-up on reconnect, replay dedupe, opaque cursors) is decided here.

const ev = (type: ChangeEvent['type'], collection: string, id: string, at = '2026-07-01T00:00:00.000Z') =>
  ({ type, collection, id, createdBy: 'userA', at }) as ChangeEvent

const frame = (cursor: string, events: ChangeEvent[]): Frame => ({ events, cursor })

/** A transport under the test's control: catch-ups are deferred so a live frame can be pushed
 *  while one is still in flight (the join race), and every call is recorded. */
function fakeTransport() {
  let handlers: StreamHandlers | null = null
  let settle: ((f: Frame) => void) | null = null
  const catchUps: (string | null)[] = []
  let opens = 0
  let closes = 0
  return {
    get opens() {
      return opens
    },
    get closes() {
      return closes
    },
    catchUps,
    open(h: StreamHandlers) {
      opens++
      handlers = h
    },
    close() {
      closes++
      handlers = null
    },
    catchUp(cursor: string | null): Promise<Frame> {
      catchUps.push(cursor)
      return new Promise<Frame>((resolve) => {
        settle = resolve
      })
    },
    /** The socket opened (or re-opened after a drop). */
    connect() {
      handlers?.onOpen()
    },
    /** A server push. */
    push(f: Frame) {
      handlers?.onFrame(f)
    },
    async reply(f: Frame) {
      settle?.(f)
      settle = null
      await flush()
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Connect and answer the initial "from now" catch-up, the state every page starts in. */
async function live(t: ReturnType<typeof fakeTransport>, cursor = 'c0') {
  t.connect()
  await t.reply(frame(cursor, []))
}

describe('#11: collection().onCreate / onUpdate / onDelete', () => {
  test('onCreate/onUpdate/onDelete dispatch only their own event type', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const got: Record<string, string[]> = { create: [], update: [], delete: [] }
    subs.on('notes', 'create', (e) => got.create.push(e.id))
    subs.on('notes', 'update', (e) => got.update.push(e.id))
    subs.on('notes', 'delete', (e) => got.delete.push(e.id))
    await live(t)

    t.push(frame('c1', [ev('create', 'notes', 'a')]))
    t.push(frame('c2', [ev('update', 'notes', 'b')]))
    t.push(frame('c3', [ev('delete', 'notes', 'c')]))

    expect(got).toEqual({ create: ['a'], update: ['b'], delete: ['c'] })
  })

  test('events are dispatched only to subscribers of their own collection', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const notes: string[] = []
    const poll: string[] = []
    subs.on('notes', 'create', (e) => notes.push(e.id))
    subs.on('shared-poll', 'create', (e) => poll.push(e.id))
    await live(t)

    t.push(frame('c1', [ev('create', 'shared-poll', 'p1')]))

    expect(poll).toEqual(['p1'])
    expect(notes).toEqual([])
  })

  test('the returned unsubscribe stops delivery', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const gone: string[] = []
    const stays: string[] = []
    const off = subs.on('notes', 'create', (e) => gone.push(e.id))
    subs.on('notes', 'create', (e) => stays.push(e.id))
    await live(t)

    t.push(frame('c1', [ev('create', 'notes', 'a')]))
    off()
    t.push(frame('c2', [ev('create', 'notes', 'b', '2026-07-01T00:00:01.000Z')]))

    expect(gone).toEqual(['a'])
    expect(stays).toEqual(['a', 'b'])
  })

  test('one stream for every subscription, opened once', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    subs.on('notes', 'create', () => {})
    subs.on('notes', 'update', () => {})
    subs.on('other', 'delete', () => {})
    expect(t.opens).toBe(1)
  })
})

describe('#8: replay — a subscription that misses events is a subscription that lies', () => {
  test('a reconnect triggers exactly ONE catch-up and replays the missed events in order, before the live frames buffered during it', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const seen: string[] = []
    subs.on('notes', 'create', (e) => seen.push(e.id))
    await live(t)
    t.push(frame('c1', [ev('create', 'notes', 'A')]))
    expect(seen).toEqual(['A'])

    // The socket dropped (a deploy terminates every WebSocket) and came back. B and C happened
    // while it was gone; D lands live while the catch-up is still in flight.
    t.connect()
    t.push(frame('c3', [ev('create', 'notes', 'D', '2026-07-01T00:00:03.000Z')]))
    await t.reply(frame('c2', [ev('create', 'notes', 'B'), ev('create', 'notes', 'C')]))

    expect(seen).toEqual(['A', 'B', 'C', 'D'])
    expect(t.catchUps).toEqual([null, 'c1'])
  })

  test('reconnect resumes from the last cursor, not from scratch', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    subs.on('notes', 'create', () => {})
    await live(t)
    t.push(frame('cA', [ev('create', 'notes', 'A')]))
    t.push(frame('cB', [ev('create', 'notes', 'B')]))

    t.connect()
    await t.reply(frame('cB', []))

    expect(t.catchUps).toEqual([null, 'cB'])
  })

  test('ATTACK: replayed events already delivered are not re-dispatched', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const seen: string[] = []
    subs.on('notes', 'create', (e) => seen.push(e.id))
    await live(t)
    t.push(frame('cA', [ev('create', 'notes', 'A')]))
    t.push(frame('cB', [ev('create', 'notes', 'B')]))

    // The catch-up window overlaps what the socket already delivered.
    t.connect()
    await t.reply(frame('cC', [ev('create', 'notes', 'A'), ev('create', 'notes', 'B'), ev('create', 'notes', 'C')]))

    expect(seen).toEqual(['A', 'B', 'C'])
  })

  test('a backlog wider than one server page is paged to the head, ahead of the frames buffered during it', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const seen: string[] = []
    subs.on('notes', 'create', (e) => seen.push(e.id))
    await live(t)

    // The socket came back to a backlog the server cannot answer in one page, and a live frame
    // lands while the SECOND page is still in flight.
    t.connect()
    await t.reply({ ...frame('c1', [ev('create', 'notes', 'A')]), more: true })
    t.push(frame('cLive', [ev('create', 'notes', 'D', '2026-07-01T00:00:03.000Z')]))
    await t.reply(frame('c2', [ev('create', 'notes', 'B'), ev('create', 'notes', 'C')]))

    // Every page asked from the cursor the previous one returned — no row is skipped, and the
    // live frame is still delivered last.
    expect(t.catchUps).toEqual([null, 'c0', 'c1'])
    expect(seen).toEqual(['A', 'B', 'C', 'D'])
  })

  test('a failed catch-up does not wedge the stream', async () => {
    const t = fakeTransport()
    const failing = { ...t, catchUp: () => Promise.reject(new Error('offline')) }
    const subs = createSubscriptions(failing)
    const seen: string[] = []
    subs.on('notes', 'create', (e) => seen.push(e.id))
    t.connect()
    await flush()

    t.push(frame('c1', [ev('create', 'notes', 'A')]))
    expect(seen).toEqual(['A'])
  })
})

describe('#9: the raw sequence never reaches a page callback', () => {
  test('a callback receives the event only — no seq, no cursor, at any depth', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    let arg: unknown
    subs.on('notes', 'create', (e) => {
      arg = e
    })
    await live(t)
    t.push(frame('opaque-cursor-1', [ev('create', 'notes', 'a')]))

    expect(Object.keys(arg as object).sort()).toEqual(['at', 'collection', 'createdBy', 'id', 'type'])
    // A deep key walk, not a substring scan: three base64url characters of a cursor would match
    // anything, whereas a leaked position can only arrive as a named field.
    expect(keysDeep(arg)).not.toContain('seq')
    expect(keysDeep(arg)).not.toContain('cursor')
  })
})

describe('subscriber isolation', () => {
  test('a throwing subscriber does not stop delivery to the others', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const fired: string[] = []
    subs.on('notes', 'create', () => {
      throw new Error('page bug')
    })
    subs.on('notes', 'create', () => fired.push('second'))
    subs.on('notes', 'create', () => fired.push('third'))
    await live(t)

    t.push(frame('c1', [ev('create', 'notes', 'a')]))

    expect(fired).toEqual(['second', 'third'])
  })
})

describe('the last unsubscribe tears the stream down', () => {
  // Before this, unsubscribe only removed the local listener: the socket, its 30s keepalive and
  // its re-auth timer outlived every callback that justified them, and dbBroker's `unsubscribe`
  // op — implemented and validated — was unreachable code.
  test('closes the transport when the final listener goes', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const off = subs.on('notes', 'create', () => {})
    await live(t)

    expect(t.closes).toBe(0)
    off()
    expect(t.closes).toBe(1)
  })

  test('keeps the stream while any listener remains', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const offA = subs.on('notes', 'create', () => {})
    const offB = subs.on('notes', 'update', () => {})
    await live(t)

    offA()
    expect(t.closes).toBe(0)
    offB()
    expect(t.closes).toBe(1)
  })

  test('a later subscribe dials again rather than listening to a closed stream', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    subs.on('notes', 'create', () => {})()
    expect(t.opens).toBe(1)

    const seen: ChangeEvent[] = []
    subs.on('notes', 'create', (e) => seen.push(e))
    expect(t.opens).toBe(2)

    await live(t, 'c1')
    t.push(frame('c2', [ev('create', 'notes', 'd1')]))
    expect(seen.map((e) => e.id)).toEqual(['d1'])
  })

  test('unsubscribing mid-replay does not deliver the backlog to a gone listener', async () => {
    const t = fakeTransport()
    const subs = createSubscriptions(t)
    const seen: ChangeEvent[] = []
    const off = subs.on('notes', 'create', (e) => seen.push(e))
    await live(t)

    t.connect()
    off()
    await t.reply(frame('c9', [ev('create', 'notes', 'late')]))
    expect(seen).toEqual([])
  })
})

describe('the committed bundle', () => {
  test('exposes onCreate/onUpdate/onDelete (build:db was run)', () => {
    expect(GLANCE_DB_JS).toContain('onCreate')
    expect(GLANCE_DB_JS).toContain('onUpdate')
    expect(GLANCE_DB_JS).toContain('onDelete')
  })

  // A substring pin goes stale the moment client.ts changes again, and NOTHING else in test,
  // typecheck or lint notices: /_glance/db.js is immutable-cached under the committed version
  // hash, so a forgotten `bun run build:db` silently serves the old shim forever. Rebuild here and
  // compare the stamp — the same build scripts/build-db.ts performs.
  test('is in sync with client.ts (content hash, not a substring)', async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'client.ts')],
      minify: true,
      format: 'iife',
      target: 'browser',
    })
    expect(built.success).toBe(true)
    const js = await built.outputs[0].text()
    expect(new Bun.CryptoHasher('sha256').update(js).digest('hex').slice(0, 8)).toBe(GLANCE_DB_VERSION)
  })
})

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v)) {
    out.push(k)
    keysDeep(val, out)
  }
  return out
}
