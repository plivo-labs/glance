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
    expect(document.body.textContent).toContain('3 files · 2kB')
    // The relative time is a hint; the exact moment is one hover away.
    expect(document.querySelector('time')?.getAttribute('title')).toBe(new Date(V2.createdAt).toLocaleString())
  })

  test('Restore asks first, then POSTs the restore and reports success', async () => {
    const calls = stubFetch([V2])
    const onRestored = renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version 2' }))
    expect(calls.some((c) => c.method === 'POST')).toBe(false) // the dialog guards the POST
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/sites/sp/site/versions/v2/restore')
  })

  test('answers to earlier opens, whether lists or failures, are ignored once the sheet was reopened', async () => {
    const answers: ((res: Response) => void)[] = []
    globalThis.fetch = (() => new Promise<Response>((resolve) => answers.push(resolve))) as unknown as typeof fetch
    const reply = (versions: SiteVersion[] | null) =>
      new Response(JSON.stringify(versions ? { versions } : { error: 'boom' }), {
        status: versions ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })
    const sheet = (open: boolean) => <HistorySheet spaceSlug="sp" siteSlug="site" open={open} onOpenChange={() => {}} />
    const { rerender } = render(sheet(true))
    for (const opens of [2, 3]) {
      await waitFor(() => expect(answers).toHaveLength(opens - 1))
      rerender(sheet(false))
      rerender(sheet(true))
    }
    await waitFor(() => expect(answers).toHaveLength(3))

    answers[2]?.(reply([V2]))
    expect(await screen.findByText('Version 2')).toBeDefined()
    answers[0]?.(reply(null)) // the first open failed, the second answered: both arrive last
    answers[1]?.(reply([{ ...V2, id: 'v1', version: 1 }]))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(document.body.textContent).toContain('Version 2')
    expect(document.body.textContent).not.toContain('Version 1')
    expect(document.body.textContent).not.toContain('Could not load history')
  })

  test('a site with no earlier versions says so', async () => {
    stubFetch([])
    renderSheet()
    expect(await screen.findByText(/No earlier versions yet/)).toBeDefined()
  })
})
