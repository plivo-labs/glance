import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { BOOKMARK_HEADER, onError, sessionDb, withDb, withDeadline } from './client'

// D1 Sessions wiring (issue #79): every /api request runs its drizzle client over a
// D1DatabaseSession so reads can route to the nearest replica, with the session bookmark
// round-tripped to the browser for cross-request read-your-write consistency.

function fakeEnv(bookmarkAfter: string | null = 'bm-after') {
  const anchors: (string | undefined)[] = []
  const session = {
    prepare: () => {
      throw new Error('no query expected in this test')
    },
    batch: () => {
      throw new Error('no query expected in this test')
    },
    getBookmark: () => bookmarkAfter,
  }
  const withSession = (a?: string) => {
    anchors.push(a)
    return session
  }
  const env = { GLANCE_DB: { withSession } } as never
  return { env, anchors }
}

function mount() {
  const app = new Hono<AppEnv>()
  app.use('*', withDb)
  app.get('/x', (c) => c.text('ok'))
  return app
}

describe('withDb — D1 session anchoring + bookmark round-trip', () => {
  test('browser request without a bookmark → first-unconstrained; response carries the session bookmark', async () => {
    const { env, anchors } = fakeEnv()
    const res = await mount().request('/x', {}, env)
    expect(res.status).toBe(200)
    expect(anchors).toEqual(['first-unconstrained'])
    expect(res.headers.get(BOOKMARK_HEADER)).toBe('bm-after')
  })

  test('browser echoes a bookmark → session anchored at it (read-your-write across requests)', async () => {
    const { env, anchors } = fakeEnv()
    await mount().request('/x', { headers: { [BOOKMARK_HEADER]: 'bm-prev' } }, env)
    expect(anchors).toEqual(['bm-prev'])
  })

  test('no query ran (null bookmark) → response carries no bookmark header', async () => {
    const { env } = fakeEnv(null)
    const res = await mount().request('/x', {}, env)
    expect(res.headers.get(BOOKMARK_HEADER)).toBeNull()
  })
})

describe('sessionDb — session-backed drizzle client (content/data workers)', () => {
  test('anchors one session at the given constraint and runs queries through it', async () => {
    const prepared: string[] = []
    const anchors: string[] = []
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    }
    const binding = {
      withSession: (a: string) => {
        anchors.push(a)
        const prepare = (q: string) => {
          prepared.push(q)
          return statement
        }
        return { prepare, getBookmark: () => null }
      },
    } as unknown as D1Database

    const db = sessionDb(binding, 'first-primary')
    await db.run(sql`select 1`)
    await db.run(sql`select 2`)

    expect(anchors).toEqual(['first-primary'])
    expect(prepared).toEqual(['select 1', 'select 2'])
  })
})

describe('withDeadline — bounded D1 calls', () => {
  const hang = () => new Promise<never>(() => {})

  test('a hung query rejects with a 503 at the deadline instead of waiting on D1', async () => {
    const statement = { bind: () => statement, all: hang, run: hang, raw: hang, first: hang }
    const session = { prepare: () => statement, batch: hang, getBookmark: () => null } as unknown as D1DatabaseSession
    const db = drizzle(withDeadline(session, 20) as unknown as D1Database)

    const app = new Hono<AppEnv>()
    app.onError(onError)
    app.get('/x', async (c) => c.json(await db.all(sql`select 1`)))
    const started = Date.now()
    const res = await app.request('/x')

    expect(res.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('batch hands D1 the native statements, not the wrappers', async () => {
    const native = { bind: () => native, all: hang, run: hang, raw: hang, first: hang }
    let received: unknown[] = []
    const session = {
      prepare: () => native,
      batch: async (stmts: unknown[]) => {
        received = stmts
        return []
      },
      getBookmark: () => null,
    } as unknown as D1DatabaseSession
    const wrapped = withDeadline(session, 20)

    await wrapped.batch([wrapped.prepare('select 1').bind(1)])

    expect(received).toEqual([native])
  })
})
