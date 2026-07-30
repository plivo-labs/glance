// The rail card's own wiring: a click on its quote/anchor chip scrolls the iframe to that anchor
// (onFocusAnchor) and does nothing else. It has no hover behaviour at all — every commented passage
// is already highlighted for as long as the rail is open, so there is nothing for a hover to light.
import { describe, expect, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { comments, type CommentItem, type CommentReaction, type Thread } from '@/lib/comments'
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

function mkComment(overrides: Partial<CommentItem> & { id: string }): CommentItem {
  return {
    id: overrides.id,
    authorId: 'u2',
    author: 'Riya',
    body: 'the axis label is cropped',
    deleted: false,
    createdAt: '2024-01-01',
    editedAt: null,
    reactions: [],
    ...overrides,
  }
}

function renderCard(
  overrides: { onFocusAnchor?: (t: Thread) => void; comments?: CommentItem[]; onChanged?: () => void } = {},
) {
  const onFocusAnchor = overrides.onFocusAnchor ?? mock((_t: Thread) => {})
  const onChanged = overrides.onChanged ?? mock(() => {})
  const thread = mkThread({ id: 't1', ...(overrides.comments ? { comments: overrides.comments } : {}) })
  const view = render(
    <ThreadCard site={SITE} me={ME} thread={thread} onChanged={onChanged} onFocusAnchor={onFocusAnchor} />,
  )
  // What a refetch looks like from this component's side: same thread id, brand-new objects and
  // arrays (they came off a fresh `comments.list` response, so nothing is identity-shared).
  const refetch = (cs: CommentItem[]) =>
    view.rerender(
      <ThreadCard
        site={SITE}
        me={ME}
        thread={mkThread({ id: 't1', comments: cs })}
        onChanged={onChanged}
        onFocusAnchor={onFocusAnchor}
      />,
    )
  // The root carries id={`thread-${thread.id}`} for the deep-link scroll target (S11) — reused
  // here instead of adding a test-only attribute.
  const card = document.getElementById(`thread-${thread.id}`) as HTMLElement
  return { onFocusAnchor, onChanged, thread, card, refetch }
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

// Reactions are the one mutation on this card that must NOT refetch: the toggle endpoints answer
// with the comment's fresh reaction list, so calling onChanged() would spend a whole thread-list
// request to learn what the response already said. These tests pin both halves — the response is
// what re-renders the chips, and onChanged stays untouched.
describe('ThreadCard — reaction chips', () => {
  const one = (reactions: CommentReaction[]) => [mkComment({ id: 'c1', reactions })]
  const FIRE_THEIRS: CommentReaction = { emoji: '🔥', count: 2, mine: false }
  const THUMB_MINE: CommentReaction = { emoji: '👍', count: 1, mine: true }

  test('chips render from the comment, with the caller’s own pressed', () => {
    renderCard({ comments: one([FIRE_THEIRS, THUMB_MINE]) })
    expect(screen.getByRole('button', { name: '🔥 2' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '👍 1' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('a comment nobody reacted to shows no chips, just the add trigger', () => {
    renderCard({ comments: one([]) })
    expect(screen.queryByRole('button', { name: /^🔥/ })).toBe(null)
    expect(screen.getByRole('button', { name: 'Add reaction' }).isConnected).toBe(true)
  })

  test('clicking someone else’s chip reacts, and re-renders from the RESPONSE — no refetch', async () => {
    const { onChanged } = renderCard({ comments: one([FIRE_THEIRS]) })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.resolve([{ emoji: '🔥', count: 3, mine: true }]),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '🔥 2' }))
    })

    expect(react.mock.calls).toEqual([[SITE, 't1', 'c1', '🔥']])
    expect(screen.getByRole('button', { name: '🔥 3' }).getAttribute('aria-pressed')).toBe('true')
    // The whole point of the endpoint returning the fresh list.
    expect(onChanged).not.toHaveBeenCalled()
    react.mockRestore()
  })

  test('clicking a chip the caller already holds unreacts, and the chip disappears when it hits zero', async () => {
    const { onChanged } = renderCard({ comments: one([THUMB_MINE]) })
    const unreact = spyOn(comments, 'unreact').mockImplementation(() => Promise.resolve([]))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '👍 1' }))
    })

    expect(unreact.mock.calls).toEqual([[SITE, 't1', 'c1', '👍']])
    expect(screen.queryByRole('button', { name: '👍 1' })).toBe(null)
    expect(onChanged).not.toHaveBeenCalled()
    unreact.mockRestore()
  })

  test('picking from the emoji picker adds a chip', async () => {
    renderCard({ comments: one([]) })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.resolve([{ emoji: '🚀', count: 1, mine: true }]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }))
    fireEvent.change(screen.getByPlaceholderText('Search emoji'), { target: { value: 'rocket' } })
    await act(async () => {
      fireEvent.click(screen.getByText('🚀'))
    })

    expect(react.mock.calls).toEqual([[SITE, 't1', 'c1', '🚀']])
    expect(screen.getByRole('button', { name: '🚀 1' }).getAttribute('aria-pressed')).toBe('true')
    react.mockRestore()
  })

  test('a rejected toggle toasts the server’s reason and leaves the chips exactly as they were', async () => {
    const { onChanged } = renderCard({ comments: one([FIRE_THEIRS]) })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.reject(new ApiError(400, 'too many reactions')),
    )
    const errorToast = spyOn(toast, 'error').mockImplementation(() => '' as never)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '🔥 2' }))
    })

    expect(errorToast.mock.calls[0]?.[0]).toBe('too many reactions')
    // Nothing was written optimistically, so there is no half-applied chip to explain away.
    expect(screen.getByRole('button', { name: '🔥 2' }).getAttribute('aria-pressed')).toBe('false')
    expect(onChanged).not.toHaveBeenCalled()
    react.mockRestore()
    errorToast.mockRestore()
  })

  test('a soft-deleted comment keeps its chips but offers no way to add one', () => {
    renderCard({ comments: [mkComment({ id: 'c1', deleted: true, body: null, reactions: [FIRE_THEIRS] })] })
    // The delete redacts the body, not the reactors — and the server 404s a new reaction on it.
    expect(screen.getByRole('button', { name: '🔥 2' }).isConnected).toBe(true)
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBe(null)
  })
})

// The override that keeps a toggle from refetching has to STOP winning once a refetch happens, or
// it silently freezes that comment: everything anyone else reacts with afterwards is invisible to
// this reader until they reload the page. There is no polling, so nothing else would ever correct
// it. The override is therefore tied to the exact `reactions` array it was computed from — a fresh
// list is a different array, and it wins.
describe('ThreadCard — a refetched reaction list supersedes the local override', () => {
  test('reactions other people added after a toggle still render', async () => {
    const { onChanged, refetch } = renderCard({
      comments: [mkComment({ id: 'c1', reactions: [{ emoji: '🔥', count: 2, mine: false }] })],
    })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.resolve([{ emoji: '🔥', count: 3, mine: true }]),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '🔥 2' }))
    })
    expect(screen.getByRole('button', { name: '🔥 3' }).isConnected).toBe(true)

    // Something else on the page refetched (a reply landed, the rail reopened). The server's list
    // moved on: a fourth reader added 🔥 and someone started a 🎉.
    await act(async () => {
      refetch([
        mkComment({
          id: 'c1',
          reactions: [
            { emoji: '🔥', count: 4, mine: true },
            { emoji: '🎉', count: 1, mine: false },
          ],
        }),
      ])
    })

    expect(screen.getByRole('button', { name: '🔥 4' }).isConnected).toBe(true)
    expect(screen.getByRole('button', { name: '🎉 1' }).isConnected).toBe(true)
    expect(screen.queryByRole('button', { name: '🔥 3' })).toBe(null) // the stale override is gone
    // Still no refetch caused BY the toggle — the fix must not reintroduce onChanged().
    expect(onChanged).not.toHaveBeenCalled()
    react.mockRestore()
  })

  test('a re-render that did NOT bring a new list leaves the override in charge', async () => {
    // The other half: React re-renders for all sorts of reasons. Only a genuinely new `reactions`
    // array may discard the toggle's answer, or every unrelated re-render would flash the old count.
    const stable = [{ emoji: '👍', count: 1, mine: false }]
    const { refetch } = renderCard({ comments: [mkComment({ id: 'c1', reactions: stable })] })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.resolve([{ emoji: '👍', count: 2, mine: true }]),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '👍 1' }))
    })

    await act(async () => {
      refetch([mkComment({ id: 'c1', reactions: stable })]) // same array, new comment object
    })

    expect(screen.getByRole('button', { name: '👍 2' }).getAttribute('aria-pressed')).toBe('true')
    react.mockRestore()
  })
})
