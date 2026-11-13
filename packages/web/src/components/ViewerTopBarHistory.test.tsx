import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ViewerSite } from '@/lib/types'
import { ViewerTopBar } from './ViewerTopBar'

// The History item opens the version-history sheet, which only the owner can use.
describe('ViewerTopBar History menu item', () => {
  const SITE: ViewerSite = {
    id: 's1',
    spaceSlug: 'sp',
    siteSlug: 'site',
    title: 'T',
    visibility: 'team',
    status: 'active',
    theme: null,
    isOwner: false,
    contentUrl: 'https://content.example.com/sp/site/',
    indexPath: 'index.html',
  }
  async function openMenu(isOwner: boolean) {
    const router = createMemoryRouter([
      {
        path: '/',
        element: (
          <ViewerTopBar
            site={{ ...SITE, isOwner }}
            sitePath=""
            railOpen={false}
            commentCount={0}
            onToggleRail={() => {}}
            onToggleSidebar={() => {}}
            onSearch={() => {}}
          />
        ),
      },
    ])
    render(<RouterProvider router={router} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Menu' }), { button: 0 })
    await screen.findByText('Fork')
  }

  test('only the owner gets it', async () => {
    await openMenu(false)
    expect(screen.queryByText('History')).toBeNull()
  })

  test('the owner sees it', async () => {
    await openMenu(true)
    expect(screen.getByText('History')).toBeDefined()
  })
})
