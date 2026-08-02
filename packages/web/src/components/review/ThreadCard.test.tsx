// The rail card's own wiring: a click on its quote/anchor chip scrolls the iframe to that anchor
// (onFocusAnchor) and does nothing else. It has no hover behaviour at all — every commented passage
// is already highlighted for as long as the rail is open, so there is nothing for a hover to light.
import { describe, expect, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { comments, type CommentItem, type CommentReaction, type Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { ThreadCard, reactorList } from './ThreadCard'

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

// The card reads as a chat, not a form: consecutive messages from one author collapse into a group
// so the avatar/name/date row is stated once per turn instead of once per message. Four "Riya ·
// 2 Aug" headers on four messages a minute apart was the bulk of the card's dead space.
describe('ThreadCard — consecutive messages from one author group under one header', () => {
  const at = (min: number) => new Date(Date.UTC(2024, 0, 1, 12, min)).toISOString()

  test('a burst from one author states the author once, and still renders every message', () => {
    renderCard({
      comments: [
        mkComment({ id: 'c1', body: 'yo yo', createdAt: at(0) }),
        mkComment({ id: 'c2', body: 'this is cool?', createdAt: at(1) }),
        mkComment({ id: 'c3', body: 'yes cool', createdAt: at(2) }),
      ],
    })
    expect(screen.getAllByText('Riya')).toHaveLength(1)
    for (const body of ['yo yo', 'this is cool?', 'yes cool']) {
      expect(screen.getByText(body).isConnected).toBe(true)
    }
  })

  test('a different author always starts a new header', () => {
    renderCard({
      comments: [
        mkComment({ id: 'c1', createdAt: at(0) }),
        mkComment({ id: 'c2', authorId: 'u1', author: 'U1', createdAt: at(1) }),
        mkComment({ id: 'c3', createdAt: at(2) }),
      ],
    })
    expect(screen.getAllByText('Riya')).toHaveLength(2)
    expect(screen.getByText('You').isConnected).toBe(true) // authorId === me.id
  })

  test('a gap longer than the group window re-states who is speaking and when', () => {
    renderCard({
      comments: [mkComment({ id: 'c1', createdAt: at(0) }), mkComment({ id: 'c2', createdAt: at(6) })],
    })
    expect(screen.getAllByText('Riya')).toHaveLength(2)
  })

  test('an unparseable date breaks the group rather than guessing — the header always says who', () => {
    renderCard({
      comments: [mkComment({ id: 'c1', createdAt: 'not a date' }), mkComment({ id: 'c2', createdAt: 'nor this' })],
    })
    expect(screen.getAllByText('Riya')).toHaveLength(2)
  })
})

// Resolve is a THREAD-level action, so it moved out of the footer (where it shared a row with Reply
// and vanished the moment the composer opened) into the card's own header. Triage is the reason the
// rail is open, so it must be reachable at all times — including mid-reply.
describe('ThreadCard — resolve lives in the thread header', () => {
  const renderOwned = (overrides: { comments?: CommentItem[]; status?: Thread['status'] } = {}) =>
    render(
      <ThreadCard
        site={{ ...SITE, isOwner: true }}
        me={ME}
        thread={mkThread({ id: 't1', status: overrides.status ?? 'open', comments: overrides.comments ?? [] })}
        onChanged={mock(() => {})}
        onFocusAnchor={mock((_t: Thread) => {})}
      />,
    )

  test('Resolve stays reachable while the reply composer is open', () => {
    renderOwned()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByPlaceholderText('Reply…').isConnected).toBe(true)
    expect(screen.getByRole('button', { name: 'Resolve' }).isConnected).toBe(true)
  })

  test('a resolved thread offers Reopen instead', () => {
    renderOwned({ status: 'resolved' })
    expect(screen.getByRole('button', { name: 'Reopen' }).isConnected).toBe(true)
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBe(null)
  })

  test('a viewer who cannot moderate gets neither, but still gets Reply', () => {
    renderCard() // SITE.isOwner false, ME.role member
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBe(null)
    expect(screen.getByRole('button', { name: 'Reply' }).isConnected).toBe(true)
  })
})

// The reply affordance is collapsed on a thread of one and pinned once the thread is a conversation
// — but it is NEVER `display:none`, or it would drop out of the accessibility tree and off the tab
// order, and a keyboard user could not reach it at all (hover is not available to them).
describe('ThreadCard — the collapsed reply trigger stays reachable', () => {
  test('a thread with no replies still exposes the reply trigger to the a11y tree', () => {
    renderCard({ comments: [mkComment({ id: 'c1' })] })
    // getByRole excludes anything hidden from assistive tech, so this passing IS the assertion.
    expect(screen.getByRole('button', { name: 'Reply' }).isConnected).toBe(true)
  })

  test('the add-reaction trigger survives moving into the hover bar, on every live comment', () => {
    renderCard({ comments: [mkComment({ id: 'c1' }), mkComment({ id: 'c2', createdAt: '2024-06-01' })] })
    expect(screen.getAllByRole('button', { name: 'Add reaction' })).toHaveLength(2)
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
  const FIRE_THEIRS: CommentReaction = { emoji: '🔥', count: 2, mine: false, names: ['Ada', 'Bo'] }
  const THUMB_MINE: CommentReaction = { emoji: '👍', count: 1, mine: true, names: [] }

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
      Promise.resolve([{ emoji: '🔥', count: 3, mine: true, names: ['Ada', 'Bo'] }]),
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
      Promise.resolve([{ emoji: '🚀', count: 1, mine: true, names: [] }]),
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

// A chip that only counts is a question, not an answer: "two people liked this — which two?". The
// names ride the same payload the count does; hover (or focus, which is how the chip is REACHED
// without a mouse) is what asks.
describe('ThreadCard — who reacted', () => {
  const chipTip = async (name: string) => {
    fireEvent.focus(screen.getByRole('button', { name }))
    return await screen.findByRole('tooltip')
  }

  test('a chip names its reactors, and calls the caller “You” rather than repeating their name', async () => {
    renderCard({
      comments: [
        mkComment({
          id: 'c1',
          reactions: [
            { emoji: '🔥', count: 2, mine: false, names: ['Ada', 'Bo'] },
            // `names` never carries the caller — `mine` is how the caller appears, so the phrase
            // reads the way the reader thinks of it.
            { emoji: '👍', count: 2, mine: true, names: ['Ada'] },
          ],
        }),
      ],
    })
    expect((await chipTip('🔥 2')).textContent).toBe('Ada and Bo reacted 🔥')
    expect((await chipTip('👍 2')).textContent).toBe('You and Ada reacted 👍')
  })

  test('past the server’s name cap the rest are counted, not dropped in silence', async () => {
    const names = ['Ada', 'Bo', 'Cy', 'Di', 'Eli', 'Fay', 'Gus', 'Hal'] // the server sends at most 8
    renderCard({ comments: [mkComment({ id: 'c1', reactions: [{ emoji: '🎉', count: 11, mine: true, names }] })] })
    expect((await chipTip('🎉 11')).textContent).toBe(`You, ${names.join(', ')} and 2 others reacted 🎉`)
  })

  test('one unnamed reactor is “1 other”, not “1 others”', () => {
    expect(reactorList({ emoji: '🎉', count: 2, mine: true, names: [] })).toBe('You and 1 other')
    expect(reactorList({ emoji: '🎉', count: 1, mine: false, names: ['Ada'] })).toBe('Ada')
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
      comments: [mkComment({ id: 'c1', reactions: [{ emoji: '🔥', count: 2, mine: false, names: ['Ada', 'Bo'] }] })],
    })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.resolve([{ emoji: '🔥', count: 3, mine: true, names: ['Ada', 'Bo'] }]),
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
            { emoji: '🔥', count: 4, mine: true, names: ['Ada', 'Bo', 'Cy'] },
            { emoji: '🎉', count: 1, mine: false, names: ['Cy'] },
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
    const stable = [{ emoji: '👍', count: 1, mine: false, names: ['Ada'] }]
    const { refetch } = renderCard({ comments: [mkComment({ id: 'c1', reactions: stable })] })
    const react = spyOn(comments, 'react').mockImplementation(() =>
      Promise.resolve([{ emoji: '👍', count: 2, mine: true, names: ['Ada'] }]),
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
