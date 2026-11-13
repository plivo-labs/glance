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
  overrides: Partial<{
    railOpen: boolean
    commentCount: number
    onToggleRail: () => void
    site: ViewerSite
    onDownload: () => void
    downloadReady: boolean
  }> = {},
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
          onDownload={overrides.onDownload}
          downloadReady={overrides.downloadReady}
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

describe('ViewerTopBar — Download opens the dialog', () => {
  const openMenu = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Menu' }), { button: 0 })

  test('one click on the icon, and the phone menu item, each open the dialog once', async () => {
    const onDownload = mock(() => {})
    renderTopBar({ onDownload })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download/ }))
    expect(onDownload).toHaveBeenCalledTimes(2)
  })

  test('nothing to download without a handler (audio), and the old hamburger print item is gone', async () => {
    renderTopBar({})
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    openMenu()
    await screen.findByRole('menuitem', { name: /Fork/ })
    expect(screen.queryByRole('menuitem', { name: /Print|Download/ })).toBeNull()
  })

  test('both controls are disabled, and do nothing, until the frame has announced itself', async () => {
    const onDownload = mock(() => {})
    renderTopBar({ onDownload, downloadReady: false })
    const button = screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /Download/ })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item)
    expect(onDownload).not.toHaveBeenCalled()
  })
})
