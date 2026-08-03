// C2b — "review mode" is gone: the Done button is deleted, and Comments is a plain TOGGLE that's
// always present (not gated on `!railOpen`) with the open-count badge riding along either way.
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ViewerSite } from '@/lib/types'
import { ViewerTopBar } from './ViewerTopBar'

const SITE: ViewerSite = {
  id: 's1',
  spaceSlug: 'sp',
  siteSlug: 'site',
  title: 'T',
  visibility: 'team',
  status: 'active',
  isOwner: false,
  contentUrl: 'https://content.example.com/sp/site/',
  indexPath: 'index.html',
}

// A DATA router, not MemoryRouter: the star control (useStar) calls useRevalidator, which throws
// outside one — the top bar cannot be rendered bare any more.
function renderTopBar(
  overrides: Partial<{ railOpen: boolean; commentCount: number; onToggleRail: () => void; site: ViewerSite }> = {},
) {
  const onToggleRail = overrides.onToggleRail ?? mock(() => {})
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <ViewerTopBar
          site={overrides.site ?? SITE}
          sitePath=""
          railOpen={overrides.railOpen ?? false}
          commentCount={overrides.commentCount ?? 0}
          onToggleRail={onToggleRail}
          onToggleSidebar={() => {}}
          onSearch={() => {}}
        />
      ),
    },
  ])
  render(<RouterProvider router={router} />)
  return { onToggleRail }
}

describe('ViewerTopBar — Comments is an always-present toggle (C2b: Done is gone)', () => {
  test('the Comments button renders with the rail CLOSED, and clicking it toggles', () => {
    const { onToggleRail } = renderTopBar({ railOpen: false })
    const button = screen.getByRole('button', { name: /Comments/ })
    fireEvent.click(button)
    expect(onToggleRail).toHaveBeenCalledTimes(1)
  })

  test('the Comments button ALSO renders with the rail OPEN, and clicking it toggles', () => {
    const { onToggleRail } = renderTopBar({ railOpen: true })
    const button = screen.getByRole('button', { name: /Comments/ })
    fireEvent.click(button)
    expect(onToggleRail).toHaveBeenCalledTimes(1)
  })

  test('there is no Done button in either state', () => {
    renderTopBar({ railOpen: true })
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  test('the open-count badge shows on the Comments button regardless of rail state', () => {
    renderTopBar({ railOpen: false, commentCount: 3 })
    expect(screen.getByRole('button', { name: /Comments/ }).textContent).toContain('3')
    renderTopBar({ railOpen: true, commentCount: 5 })
    expect(screen.getAllByRole('button', { name: /Comments/ }).at(-1)?.textContent).toContain('5')
  })
})

describe('ViewerTopBar — the visibility tier rides beside the site name', () => {
  test('a viewer (not the owner) sees the tier as a read-only chip', () => {
    renderTopBar({ site: { ...SITE, visibility: 'members', isOwner: false } })
    expect(screen.getByText('Members')).toBeTruthy()
    // Read-only: the chip is text, not a picker trigger.
    expect(screen.queryByRole('button', { name: /Members/ })).toBeNull()
  })

  test('the owner gets the picker trigger for the tier', () => {
    renderTopBar({ site: { ...SITE, visibility: 'private', isOwner: true } })
    expect(screen.getByRole('button', { name: /Private/ })).toBeTruthy()
  })
})
