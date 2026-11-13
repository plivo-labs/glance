import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SiteVersion } from '@/lib/versions'
import { HistorySheet } from './HistorySheet'

const V2: SiteVersion = {
  id: 'v2',
  version: 2,
  createdAt: new Date().toISOString(),
  createdBy: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  fileCount: 3,
  totalSize: 2048,
}

function stubFetch(versions: SiteVersion[]) {
  const calls: { url: string; method: string }[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const body = init?.method === 'POST' ? { ok: true } : { versions }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
  }) as unknown as typeof fetch
  return calls
}

const renderSheet = (onRestored = mock(() => {})) => {
  render(<HistorySheet spaceSlug="sp" siteSlug="site" open onOpenChange={() => {}} onRestored={onRestored} />)
  return onRestored
}

describe('HistorySheet', () => {
  test('lists each version with who, file count and size', async () => {
    stubFetch([V2])
    renderSheet()
    expect(await screen.findByText('Version 2')).toBeDefined()
    expect(document.body.textContent).toContain('by Ada')
    expect(document.body.textContent).toContain('3 files · 2.0 KB')
  })

  test('Restore asks first, then POSTs the restore and reports success', async () => {
    const calls = stubFetch([V2])
    const onRestored = renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    expect(calls.some((c) => c.method === 'POST')).toBe(false) // the dialog guards the POST
    // The dialog's confirm button shares the row button's label; it is the last one in the DOM.
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' }).at(-1) as HTMLElement)
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/sites/sp/site/versions/v2/restore')
  })

  test('a site with no earlier versions says so', async () => {
    stubFetch([])
    renderSheet()
    expect(await screen.findByText(/No earlier versions yet/)).toBeDefined()
  })
})
