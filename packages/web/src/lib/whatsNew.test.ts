import { describe, expect, test } from 'bun:test'
import { EMPTY_WHATS_NEW, openWhatsNew, whatsNew, type WhatsNewList } from './whatsNew'

// Capture the last fetch call so we assert on the REQUEST (path/method/credentials/body),
// not just that the module imports api.
function stubFetch(response: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }) as unknown as typeof fetch
  return calls
}

describe('E2 web.client.behavior', () => {
  test('list() GETs /api/whats-new with credentials included', async () => {
    const calls = stubFetch(EMPTY_WHATS_NEW)
    await whatsNew.list()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/whats-new')
    expect(calls[0].init?.credentials).toBe('include')
    expect((calls[0].init?.method ?? 'GET')).toBe('GET')
  })

  test('seen(d) POSTs /api/whats-new/seen with the exact JSON body + credentials', async () => {
    const calls = stubFetch({ ok: true })
    await whatsNew.seen('2026-07-01T15:00:00.000Z')
    expect(calls[0].url).toBe('/api/whats-new/seen')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.credentials).toBe('include')
    expect(calls[0].init?.body).toBe(JSON.stringify({ throughDate: '2026-07-01T15:00:00.000Z' }))
  })
})

describe('E3 ui.state.transition — openWhatsNew pure fn', () => {
  const base: WhatsNewList = {
    items: [{ slug: 's', title: 't', date: '2026-07-01T15:00:00.000Z', featured: false, bodyHtml: '<p>x</p>' }],
    unreadCount: 3,
    throughDate: '2026-07-01T15:00:00.000Z',
  }
  test('opening with unread → clears the badge and persists the throughDate', () => {
    const { state, persist } = openWhatsNew(base)
    expect(state.unreadCount).toBe(0)
    expect(persist).toBe('2026-07-01T15:00:00.000Z')
    expect(state.items).toBe(base.items) // items untouched
  })
  test('opening with 0 unread → no state change, nothing to persist (dot already hidden)', () => {
    const caughtUp: WhatsNewList = { ...base, unreadCount: 0 }
    const { state, persist } = openWhatsNew(caughtUp)
    expect(state).toBe(caughtUp)
    expect(persist).toBeNull()
  })
  test('unread but throughDate null → badge clears yet nothing to persist (component guards on persist)', () => {
    const { state, persist } = openWhatsNew({ items: [], unreadCount: 2, throughDate: null })
    expect(state.unreadCount).toBe(0)
    expect(persist).toBeNull()
  })
})
