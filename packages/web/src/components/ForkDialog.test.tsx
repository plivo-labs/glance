// Fork asks first: the menu item opens this dialog, and only its Fork button POSTs. The dialog
// owns the form (name + visibility); the hook still owns the request, the toast and the navigate.
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Visibility } from '@/lib/types'
import { ForkDialog } from './ForkDialog'

const SITE = { spaceSlug: 'sp', siteSlug: 'my-site', title: 'My Page', visibility: 'members' as Visibility }

type Call = { url: string; body: Record<string, unknown> }

function stubFetch(status = 200, body: unknown = { spaceSlug: 'me', siteSlug: 'my-page-copy' }) {
  const calls: Call[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
  }) as unknown as typeof fetch
  return calls
}

// A DATA router: useForkSite navigates to the fork on success. The splat route swallows that
// navigation so a successful fork doesn't blow up the render.
function renderDialog(site: typeof SITE = SITE) {
  const onOpenChange = mock((_open: boolean) => {})
  const router = createMemoryRouter([
    { path: '/', element: <ForkDialog site={site} open onOpenChange={onOpenChange} /> },
    { path: '*', element: null },
  ])
  render(<RouterProvider router={router} />)
  return { onOpenChange, name: screen.getByLabelText('Name') as HTMLInputElement }
}

const clickFork = () => fireEvent.click(screen.getByRole('button', { name: 'Fork' }))

describe('ForkDialog', () => {
  test('prefills the name from the source title and shows the slug it derives', () => {
    const { name } = renderDialog()
    expect(name.value).toBe('My Page (copy)')
    expect(document.body.textContent).toContain('my-page-copy')
  })

  test('a site with NO title falls back to its slug', () => {
    const { name } = renderDialog({ ...SITE, title: null })
    expect(name.value).toBe('my-site (copy)')
    expect(document.body.textContent).toContain('my-site-copy')
  })

  test('the visibility picker defaults to the source tier (a fork is never silently widened)', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: /Members/ })).toBeDefined()
  })

  test('Fork POSTs the name, the derived slug and the chosen visibility — then closes', async () => {
    const calls = stubFetch()
    const { onOpenChange } = renderDialog()
    clickFork()
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]?.url).toBe('/api/sites/sp/my-site/fork')
    expect(calls[0]?.body).toEqual({ title: 'My Page (copy)', slug: 'my-page-copy', visibility: 'members' })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  test('a name with no usable slug sends NO slug key — the API’s -copy dedupe names the copy', async () => {
    const calls = stubFetch()
    const { name } = renderDialog()
    fireEvent.change(name, { target: { value: '🙂' } })
    clickFork()
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]?.body).toEqual({ title: '🙂', visibility: 'members' })
    expect('slug' in (calls[0]?.body ?? {})).toBe(false)
  })

  test('a 409 slug conflict leaves the dialog OPEN so the name can be edited', async () => {
    const calls = stubFetch(409, { error: 'a site with this slug already exists in that space', conflict: true })
    const { onOpenChange, name } = renderDialog()
    clickFork()
    await waitFor(() => expect(calls.length).toBe(1))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Fork' }) as HTMLButtonElement).disabled).toBe(false),
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(name.isConnected).toBe(true)
  })
})
