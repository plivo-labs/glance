// The route + the way in (S10) got the shell and the empty state. S11 adds the real rows: grants,
// expiry, last-used, secretHint, and the revoke flow — same "feed the loader directly" pattern as
// viewer.test.tsx, the real loader (network) is bypassed entirely.
import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ApiKeyItem } from '@/lib/types'
import { Component } from './settings-keys'
import type { ApiKeyListData } from './settings-keys'

function renderPage(data: ApiKeyListData) {
  const router = createMemoryRouter([{ path: '/settings/keys', Component, loader: () => data }], {
    initialEntries: ['/settings/keys'],
  })
  return render(<RouterProvider router={router} />)
}

const ACTIVE: ApiKeyItem = {
  id: 'k-active',
  name: 'CI pipeline',
  grants: { control: false, data: { scope: { kind: 'all-owned' }, caps: ['read'] } },
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
  secretHint: 'glk_…4mR2',
}

const REVOKED: ApiKeyItem = {
  ...ACTIVE,
  id: 'k-revoked',
  name: 'Old laptop',
  revokedAt: '2026-02-01T00:00:00.000Z',
  secretHint: 'glk_…z9Q1',
}

function stubDelete() {
  const calls: string[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    return Promise.resolve(new Response(JSON.stringify({ revoked: true }), { status: 200 }))
  }) as unknown as typeof fetch
  return calls
}

describe('settings-keys', () => {
  test('no keys → the empty state from the wireframe', async () => {
    renderPage({ items: [] })
    expect(await screen.findByText('No API keys yet.')).toBeDefined()
  })

  test('links to the API keys docs page', async () => {
    renderPage({ items: [] })
    const link = (await screen.findByText(/How keys work/)).closest('a')
    expect(link?.getAttribute('href')).toBe('/docs/api-keys')
  })

  test('a revoked key STAYS in the list, styled inert, instead of disappearing', async () => {
    renderPage({ items: [ACTIVE, REVOKED] })
    expect(await screen.findByText('Old laptop')).toBeDefined()
    expect(screen.getByText('CI pipeline')).toBeDefined()
    // Tombstoned: a status badge instead of a live Revoke action.
    expect(screen.getByText('Revoked')).toBeDefined()
    // Only the active row still offers Revoke.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  // "last used" is half the slice title and had no assertion — every cell in the row could have
  // been replaced with a literal and the suite stayed green.
  test('a row renders its grants, expiry, secret hint and last-used', async () => {
    renderPage({ items: [{ ...ACTIVE, lastUsedAt: '2026-01-02T00:00:00.000Z' }] })
    const row = (await screen.findByText('CI pipeline')).closest('tr')
    if (!row) throw new Error('row not found')
    const text = row.textContent ?? ''
    expect(text).toContain('glk_…4mR2')
    expect(text).toContain('2099-01-01')
    expect(text.toLowerCase()).toContain('all owned')
    expect(text).not.toContain('Never used')
  })

  test('a key that has never been used says so rather than rendering an empty cell', async () => {
    renderPage({ items: [ACTIVE] })
    const row = (await screen.findByText('CI pipeline')).closest('tr')
    expect(row?.textContent).toContain('Never used')
  })

  // The other half of the tombstone: both fixtures expire in 2099, so the expired branch — the
  // 'Expired' badge and the suppressed Revoke — never executed.
  test('an EXPIRED key is inert too: badge shown, Revoke withheld', async () => {
    renderPage({ items: [{ ...ACTIVE, id: 'k-stale', name: 'Stale key', expiresAt: '2020-01-01T00:00:00.000Z' }] })
    expect(await screen.findByText('Stale key')).toBeDefined()
    expect(screen.getByText('Expired')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  test('revoking asks for confirmation before it issues the DELETE', async () => {
    const calls = stubDelete()
    renderPage({ items: [ACTIVE] })
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Revoke "CI pipeline"\?/)).toBeDefined()
    // The confirm click hasn't happened yet — no request fired just from opening the dialog.
    expect(calls).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(calls).toEqual(['DELETE /api/api-keys/k-active']))
    await waitFor(() => expect(screen.getByText('Revoked')).toBeDefined())
  })
})
