import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { CommandPalette } from './CommandPalette'

// A page-text hit shows its excerpt under the title with the typed words emphasized; a name hit
// (or an older server that sends no snippet) renders the title row alone.
const HIT = { id: 'a', spaceSlug: 'sp', siteSlug: 'plan', title: 'Plan', visibility: 'team', status: 'active', url: 'https://x/sp/plan', createdAt: '', updatedAt: '' }

async function search(q: string, rows: unknown[]) {
  globalThis.fetch = (() => Promise.resolve(Response.json(rows))) as unknown as typeof fetch
  render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <CommandPalette open onOpenChange={() => {}} user={null} /> }])} />)
  fireEvent.change(await screen.findByPlaceholderText(/Search all your sites/), { target: { value: q } })
  await waitFor(() => expect(document.body.textContent).toContain('sp/plan'), { timeout: 2000 }) // past the 200ms debounce
}

describe('CommandPalette content hits', () => {
  test('a content hit renders its snippet with the typed word marked; a name hit has no snippet row', async () => {
    await search('billing', [{ ...HIT, matchedIn: 'content', snippet: 'the Billing migration plan' }, { ...HIT, id: 'b', siteSlug: 'plan2', matchedIn: 'name' }])
    const snippets = screen.getAllByTestId('palette-site-snippet')
    expect(snippets.map((s) => s.textContent)).toEqual(['the Billing migration plan'])
    expect([...snippets[0]!.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Billing'])
  })
})
