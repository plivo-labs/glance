// The rail card's own wiring: a click on its quote/anchor chip scrolls the iframe to that anchor
// (onFocusAnchor) and does nothing else. It has no hover behaviour at all — every commented passage
// is already highlighted for as long as the rail is open, so there is nothing for a hover to light.
import { describe, expect, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { comments, type Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { ThreadCard } from './ThreadCard'

const SITE: ViewerSite = {
  id: 's1',
  spaceSlug: 'sam',
  siteSlug: 'site',
  title: 'Site',
  visibility: 'team',
  status: 'active',
  isOwner: false,
  contentUrl: 'https://example.com/',
  indexPath: 'index.html',
}

const ME: Me = { id: 'u1', email: 'u1@example.com', name: 'U1', role: 'member', hasUsedCli: false }

function mkThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    id: overrides.id,
    filePath: '/f',
    anchorType: 'text',
    quote: 'the quoted sentence',
    anchor: null,
    context: null,
    status: 'open',
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: null,
    createdByName: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comments: [],
    ...overrides,
  }
}

function renderCard(overrides: { onFocusAnchor?: (t: Thread) => void } = {}) {
  const onFocusAnchor = overrides.onFocusAnchor ?? mock((_t: Thread) => {})
  const thread = mkThread({ id: 't1' })
  render(<ThreadCard site={SITE} me={ME} thread={thread} onChanged={() => {}} onFocusAnchor={onFocusAnchor} />)
  // The root carries id={`thread-${thread.id}`} for the deep-link scroll target (S11) — reused
  // here instead of adding a test-only attribute.
  const card = document.getElementById(`thread-${thread.id}`) as HTMLElement
  return { onFocusAnchor, thread, card }
}

describe('ThreadCard — a click scrolls, and the card has no hover behaviour', () => {
  test('clicking the quote calls onFocusAnchor with the thread (scroll)', () => {
    const { onFocusAnchor, thread } = renderCard()
    fireEvent.click(screen.getByText(`“${thread.quote}”`))
    expect(onFocusAnchor).toHaveBeenCalledTimes(1)
    expect(onFocusAnchor).toHaveBeenCalledWith(thread)
  })

  test('pointer/focus events on the card root do nothing — no hover handlers are wired at all', () => {
    // The card used to light its anchor on enter/focus and clear it on leave/blur. That whole
    // affordance is gone with the badges: pinned here so re-adding a hover handler is a deliberate
    // choice rather than something that slips back in unnoticed.
    const { onFocusAnchor, card } = renderCard()
    fireEvent.pointerEnter(card)
    fireEvent.pointerLeave(card)
    fireEvent.focus(card)
    fireEvent.blur(card)
    expect(onFocusAnchor).not.toHaveBeenCalled()
  })
})

// GF — A-FAILED-WRITE-PRESERVES-THE-DRAFT, reply path. Composer's own test pins the TEXT half at the
// component level (a rejected onSubmit keeps the draft); this pins the half ThreadCard owns: `run`
// toasts and RETHROWS, and the reply handler awaits it, so `setReplying(false)` never runs on a
// failure. Resolve-on-error here would unmount the composer with the typed reply inside it — the
// draft would be gone with nothing to retry, and Composer alone cannot prevent that.
describe('ThreadCard — a failed reply keeps the composer open on its draft', () => {
  const REPLY = 'the second paragraph contradicts this'

  function openReplyComposer() {
    const { thread } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' })) // the low-emphasis text action
    const textarea = screen.getByPlaceholderText('Reply…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: REPLY } })
    // Both the trigger and the composer's submit are named "Reply"; the trigger is gone once the
    // composer is open, so the remaining one is the submit.
    const submit = screen.getByRole('button', { name: 'Reply' }) as HTMLButtonElement
    return { thread, textarea, submit }
  }

  test('a rejected reply leaves the composer mounted with the text intact, and retryable', async () => {
    const { textarea, submit } = openReplyComposer()
    const reply = spyOn(comments, 'reply').mockImplementation(() => Promise.reject(new Error('write failed')))

    await act(async () => {
      fireEvent.click(submit)
    })

    expect(reply).toHaveBeenCalledTimes(1)
    expect(textarea.isConnected).toBe(true) // setReplying(false) must NOT have run
    expect(textarea.value).toBe(REPLY)
    expect(submit.disabled).toBe(false) // busy latch released — the same draft can be sent again
    reply.mockRestore()
  })

  test('a resolved reply closes the composer (the other half — proves the test above is not vacuous)', async () => {
    const { textarea } = openReplyComposer()
    const submit = screen.getByRole('button', { name: 'Reply' })
    const reply = spyOn(comments, 'reply').mockImplementation(() => Promise.resolve({ ok: true } as never))

    await act(async () => {
      fireEvent.click(submit)
    })

    expect(reply).toHaveBeenCalledTimes(1)
    expect(textarea.isConnected).toBe(false)
    reply.mockRestore()
  })
})
