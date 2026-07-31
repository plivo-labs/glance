// The avatar dropdown's entry points — this only covers the /settings/keys link (S10); the rest
// of the menu already ships and isn't re-asserted here.
import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Me } from '@/lib/types'
import { AppShell } from './AppShell'

const USER: Me = { id: 'u1', email: 'a@b.com', name: 'Ada', role: 'member', hasUsedCli: true }

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: AppShell,
        loader: () => ({
          user: USER,
          notifications: Promise.resolve({ items: [], unreadCount: 0 }),
          whatsNew: Promise.resolve({ items: [], unreadCount: 0, throughDate: null }),
        }),
        children: [{ index: true, element: null }],
      },
    ],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

describe('AppShell avatar menu', () => {
  test('links to /settings/keys', async () => {
    renderShell()
    // Radix's DropdownMenuTrigger opens on pointerdown, not click (see its source) — a plain
    // fireEvent.click never toggles it in happy-dom.
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Account menu' }), { button: 0 })
    const link = (await screen.findByText('API Keys')).closest('a')
    expect(link?.getAttribute('href')).toBe('/settings/keys')
  })
})
