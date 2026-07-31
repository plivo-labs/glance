// S12: the walkthrough (rendered in both the dashboard empty state and the HelpButton sheet)
// links to the API keys docs page — one link, both surfaces, for free.
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { GettingStarted } from './GettingStarted'

function renderIt() {
  const router = createMemoryRouter([{ path: '/', Component: GettingStarted }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

describe('GettingStarted', () => {
  test('links to /docs/api-keys', async () => {
    renderIt()
    const link = (await screen.findByText(/API keys/)).closest('a')
    expect(link?.getAttribute('href')).toBe('/docs/api-keys')
  })
})
