// The docs page is the slice's actual deliverable, and it was shipping with no coverage at all:
// rewriting its heading and breaking both of its outbound links left the whole web suite green.
// These assert the things a reader depends on — that the page renders, that it points at the real
// keys screen, and that the two claims most likely to rot (the env var name, and create-but-never-
// delete) are still on it.
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Component } from './docs-api-keys'

function renderDocs() {
  const router = createMemoryRouter([{ path: '/docs/api-keys', Component }], {
    initialEntries: ['/docs/api-keys'],
  })
  return render(<RouterProvider router={router} />)
}

describe('docs/api-keys', () => {
  test('renders the page heading', async () => {
    renderDocs()
    expect(await screen.findByRole('heading', { name: 'API Keys' })).toBeDefined()
  })

  test('every link to the keys screen points at the route that actually exists', async () => {
    renderDocs()
    const links = (await screen.findAllByRole('link')).filter((a) =>
      (a.getAttribute('href') ?? '').startsWith('/settings'),
    )
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect(a.getAttribute('href')).toBe('/settings/keys')
  })

  test('documents the env var the CLI actually reads, and the create-not-delete limit', async () => {
    renderDocs()
    const text = (await screen.findByRole('heading', { name: 'API Keys' })).closest('div')?.parentElement?.textContent
    expect(text).toContain('GLANCE_TOKEN')
    expect(text?.toLowerCase()).toContain('delete')
  })

  // The reason a script reaches for a key at all is reading/writing a page's data, and that needs
  // BOTH halves: the mint (a key is refused on the data plane) and the CRUD surface it unlocks.
  // Documenting one without the other leaves a reader stuck, so assert the pair.
  test('documents the data-token exchange and every /api/_data verb', async () => {
    renderDocs()
    const text = (await screen.findByRole('heading', { name: 'API Keys' })).closest('div')?.parentElement?.textContent
    expect(text).toContain('/api/data-token/')
    for (const path of ['/api/_data/:collection', '/api/_data/:collection/:docId']) {
      expect(text).toContain(path)
    }
    for (const verb of ['GET', 'POST', 'PUT', 'DELETE']) expect(text).toContain(verb)
  })
})
