// Minting a key is the one moment the plaintext secret exists client-side. These tests pin the
// two properties that matter most: the expiry control can only ever produce one of the server's
// six fixed durations (never a free-text date), and the secret is truly SHOW-ONCE — gone from the
// UI the instant the dialog closes, not merely hidden behind a re-openable toggle.
import { useState } from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { API_KEY_PREFIX, type ApiKeyGrants, type ApiKeyItem } from '@/lib/types'
import { ApiKeyDialog } from './ApiKeyDialog'

// Composed from the exported prefix rather than written out: a key-shaped literal in a test file
// trips the repo's pre-commit secret scanner.
const plaintext = `${API_KEY_PREFIX}ABCDEFGH1234`

const SITE = {
  id: 'site-1',
  spaceSlug: 'sp',
  siteSlug: 'my-site',
  title: 'My Site',
  visibility: 'private',
  status: 'active',
}

// POST /api/api-keys request body (packages/web/src/components/ApiKeyDialog.tsx); GET requests
// send no body, hence Partial.
type MintRequestBody = { name: string; expiresInDays: number; grants: ApiKeyGrants }
type Call = { url: string; method: string; body: Partial<MintRequestBody> }

function stubFetch(
  mintBody: unknown = {
    id: 'k1',
    name: 'ci key',
    secret: plaintext,
    grants: { control: false, data: null },
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  },
) {
  const calls: Call[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? (JSON.parse(String(init.body)) as Partial<MintRequestBody>) : {} })
    if (url === '/api/sites/mine') {
      return Promise.resolve(
        new Response(JSON.stringify([SITE]), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(mintBody), { status: 201, headers: { 'content-type': 'application/json' } }),
    )
  }) as unknown as typeof fetch
  return calls
}

function stubClipboard() {
  const writeText = mock(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

// Mirrors how settings-keys.tsx drives the dialog: `open` lives in the PARENT, so closing and
// reopening re-renders the SAME ApiKeyDialog instance rather than remounting it — the real test
// of whether the secret was cleared, not merely never re-fetched.
const noopOnMinted = (_key: ApiKeyItem) => {}

function Harness({ onMinted = noopOnMinted }: { onMinted?: (key: ApiKeyItem) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <ApiKeyDialog open={open} onOpenChange={setOpen} onMinted={onMinted} />
    </>
  )
}

async function fillAndMint(name = 'ci key') {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  await waitFor(() => expect(screen.getByText('sp/my-site')).toBeDefined())
  fireEvent.click(screen.getByLabelText('sp/my-site'))
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
}

describe('ApiKeyDialog — expiry is a fixed dropdown', () => {
  test('offers exactly the six server durations and no free-text date entry', async () => {
    stubFetch()
    render(<Harness />)
    expect(document.querySelector('input[type="date"]')).toBeNull()

    fireEvent.click(screen.getByLabelText('Expires'))
    const listbox = await screen.findByRole('listbox')
    const options = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['1 day', '7 days', '30 days', '90 days', '180 days', '1 year'])
  })
})

describe('ApiKeyDialog — grants picker', () => {
  test('defaults to the site allowlist, not all-owned', async () => {
    stubFetch()
    render(<Harness />)
    await waitFor(() => expect(screen.getByText('sp/my-site')).toBeDefined())
    expect((screen.getByLabelText('Selected sites') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('All owned sites') as HTMLInputElement).checked).toBe(false)
  })

  // The controls above are only worth anything if the value they hold is what actually reaches the
  // server. Without this the whole payload — endpoint, duration, scope, capability ceiling — was
  // unpinned: the dialog could POST anything and every other test here would still pass.
  test('POSTs exactly what the form holds — endpoint, duration, scope and least-privilege caps', async () => {
    const calls = stubFetch()
    render(<Harness />)
    await fillAndMint()

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/api-keys')
    expect(post?.body).toEqual({
      name: 'ci key',
      expiresInDays: 30,
      grants: {
        control: false,
        data: { scope: { kind: 'sites', siteIds: ['site-1'] }, caps: ['read'] },
      },
    })
  })

  // The capability ceiling has to be expressible, not just enforced server-side. Before this the
  // dialog hardcoded all four capabilities, so every key minted from the UI carried maximum data
  // privilege and CASE-10's narrowing could never actually be exercised by a real user.
  test('the data-access tier chooses the capability ceiling that is sent', async () => {
    const calls = stubFetch()
    render(<Harness />)
    await waitFor(() => expect(screen.getByText('sp/my-site')).toBeDefined())

    fireEvent.click(screen.getByLabelText('Data access'))
    const listbox = await screen.findByRole('listbox')
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Read only', 'Read & submit', 'Full access'])
    fireEvent.click(within(listbox).getByRole('option', { name: 'Read & submit' }))

    await fillAndMint()
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const grants = calls.find((c) => c.method === 'POST')?.body.grants as { data: { caps: string[] } }
    expect(grants.data.caps).toEqual(['read', 'create'])
  })
})

describe('ApiKeyDialog — show-once', () => {
  test('mint shows the secret once with a Copy control; closing and reopening does NOT show it again', async () => {
    stubClipboard()
    stubFetch()
    render(<Harness />)
    await fillAndMint()

    expect(await screen.findByText(plaintext)).toBeDefined()
    const copyBtn = screen.getByRole('button', { name: 'Copy' })
    fireEvent.click(copyBtn)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(plaintext))

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText(plaintext)).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
    expect(screen.queryByText(plaintext)).toBeNull()
    expect(await screen.findByLabelText('Name')).toBeDefined()
  })

  test('onMinted receives a list row with a hint derived from the secret, never the secret itself', async () => {
    stubFetch()
    const onMinted = mock((_key: ApiKeyItem) => {})
    render(<Harness onMinted={onMinted} />)
    await fillAndMint()
    await waitFor(() => expect(onMinted).toHaveBeenCalled())
    const key = onMinted.mock.calls[0]?.[0] as ApiKeyItem
    expect(key.secretHint).toBe(`${API_KEY_PREFIX}…1234`)
    expect(JSON.stringify(key)).not.toContain(plaintext)
  })
})
