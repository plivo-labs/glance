// Slice C1b — the deep-link/highlight-click reveal used to key on thread id alone (`revealedRef`),
// so asking to reveal the SAME thread a second time was silently a no-op. It's now keyed on a
// caller-bumped NONCE (lib/viewerCommands' shouldReveal) — same id + bumped nonce reveals again,
// unchanged nonce across a re-render does not.
import { describe, expect, jest, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CommentItem, Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { ReviewRail, type TypingPing } from './ReviewRail'

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

function renderRail(threads: Thread[], focusRequest: { id: string; nonce: number } | null) {
  return render(
    <ReviewRail
      site={SITE}
      me={ME}
      threads={threads}
      composing={null}
      onCancelComposer={() => {}}
      onCreate={() => {}}
      onCreateVoice={() => {}}
      onChanged={() => {}}
      onFocusAnchor={() => {}}
      onClose={() => {}}
      onStartComment={() => {}}
      focusRequest={focusRequest}
    />,
  )
}

describe('ReviewRail — the header ✕ closes the panel (C2b: replaces the ViewerTopBar Done button)', () => {
  test('clicking the close button calls onClose', () => {
    const onClose = () => {
      called = true
    }
    let called = false
    render(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={[]}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
        onClose={onClose}
        onStartComment={() => {}}
        focusRequest={null}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close comments' }))
    expect(called).toBe(true)
  })
})

// #112 — page comments used to be an audio-only affordance: `onStartComment` was optional, viewer
// passed it only when isAudio, and the rail rendered the trigger only when it was set. It is now
// REQUIRED and always rendered, so a page comment can be written from any content type. The
// alternative considered — an always-mounted textarea instead of this button — was rejected: the
// rail's `composing` and the popover's own composer are independent states, so an always-open
// textarea makes "two live drafts at once" the default on every text selection.
describe('ReviewRail — the page-comment trigger (#112)', () => {
  function renderWithStart(extra: { getCurrentTime?: () => number } = {}) {
    let started = 0
    const view = render(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={[]}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
        onClose={() => {}}
        onStartComment={() => {
          started++
        }}
        focusRequest={null}
        {...extra}
      />,
    )
    return { ...view, startedCount: () => started }
  }

  test('the trigger is offered with no audio player present, and clicking it starts a page comment', () => {
    // No getCurrentTime — i.e. an HTML page, the exact case the old gate excluded.
    const { startedCount } = renderWithStart()
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(startedCount()).toBe(1)
  })

  test('the empty state names BOTH creation paths on a page you can select text in', () => {
    renderWithStart()
    const empty = screen.getByText(/Add a comment above/)
    // Naming only the button would leave the selection path undiscoverable now that the rail no
    // longer says "Select text to comment."
    expect(empty.textContent).toContain('select text')
  })

  test('the audio empty state does NOT offer a select-text path (there is no DOM to select in)', () => {
    renderWithStart({ getCurrentTime: () => 0 })
    const empty = screen.getByText(/Add a comment above/)
    expect(empty.textContent).not.toContain('select text')
    expect(empty.textContent).toContain('timestamp')
  })
})

// S12 / C22 — "X is replying…". The wire carries a VIEWER ID and an ABSOLUTE expiry, nothing else:
// the rail maps the id to a name it already had (the thread's own participants) and forgets the
// ping on its OWN clock, because a closed laptop just stops pinging and no retraction is ever sent.
describe('ReviewRail — the typing indicator (C22)', () => {
  const riya: CommentItem = {
    id: 'c1',
    authorId: 'u2',
    author: 'Riya',
    body: 'the axis label is cropped',
    deleted: false,
    reactions: [],
    createdAt: '2024-01-01',
    editedAt: null,
  }
  const THREADS = [mkThread({ id: 't1', comments: [riya] }), mkThread({ id: 't2' })]

  function renderTyping(typing: TypingPing[], threads: Thread[] = THREADS) {
    return render(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={threads}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
        onClose={() => {}}
        onStartComment={() => {}}
        focusRequest={null}
        typing={typing}
      />,
    )
  }

  /** A card's text, as a string — never a node assertion: a failing node comparison pretty-prints
   *  the whole React-attached happy-dom tree (the S9 incident: 66 MB and no verdict). */
  const cardText = (id: string) => document.getElementById(`thread-${id}`)?.textContent ?? `no card ${id}`

  test('a ping names the typist from the thread’s OWN participants, and touches no other card', () => {
    renderTyping([{ viewerId: 'u2', threadId: 't1', expiresAt: Date.now() + 20_000 }])

    expect(cardText('t1')).toContain('Riya is replying…')
    // The event names ONE thread; every other card is untouched by it.
    expect(cardText('t2')).not.toContain('replying')
  })

  test('an id the rail does not recognise is "Someone", never a name it happens to have', () => {
    // u9 has never written in t1, so the rail has no name for it. The only names in reach are the
    // thread's own participants — rendering one of THOSE would make "Riya is replying…" claimable
    // by anyone with a socket, which is the whole reason the wire carries an id and nothing else.
    renderTyping([{ viewerId: 'u9', threadId: 't1', expiresAt: Date.now() + 20_000 }])

    expect(cardText('t1')).toContain('Someone is replying…')
    expect(cardText('t1')).not.toContain('Riya is replying…')
  })

  test('the indicator expires on the LOCAL clock — no second message, no server timer', () => {
    // The closed-laptop case: the sender stops pinging and NOTHING else ever arrives. Only this
    // rail's own timer can take the line down.
    jest.useFakeTimers()
    try {
      renderTyping([{ viewerId: 'u2', threadId: 't1', expiresAt: Date.now() + 20_000 }])
      expect(cardText('t1')).toContain('Riya is replying…')

      act(() => void jest.advanceTimersByTime(20_000))

      expect(cardText('t1')).not.toContain('replying')
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('ReviewRail — reveal-by-nonce', () => {
  test('the default filter (open) hides a resolved thread until it is revealed, then switches tabs', () => {
    const threads = [mkThread({ id: 't1', status: 'resolved' })]
    renderRail(threads, { id: 't1', nonce: 1 })
    expect(document.getElementById('thread-t1')).toBeTruthy()
    // The 'resolved' tab button is now the active one — existing behaviour, must not regress.
    expect(screen.getByRole('button', { name: 'resolved' }).className).toContain('font-medium')
  })

  test('re-requesting the SAME thread id with a BUMPED nonce reveals it again (the bug: today the 2nd is dropped)', () => {
    const threads = [mkThread({ id: 't1', status: 'resolved' })]
    const { rerender } = renderRail(threads, { id: 't1', nonce: 1 })
    expect(screen.getByRole('button', { name: 'resolved' }).className).toContain('font-medium')

    // User manually switches to the open tab — a REAL click, not another reveal request. This is
    // the step the old id-only guard (revealedRef.current === id) could survive undetected: since
    // nothing re-requests t1 here, only a click flips the filter, an id-keyed test can't tell the
    // two guards apart until t1 is re-requested below.
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByRole('button', { name: 'open' }).className).toContain('font-medium')

    // ...then t1 is requested again at a bumped nonce — must reveal (switch back to resolved)
    // again. The old id-keyed guard sees the SAME id as already-revealed and drops this silently.
    rerender(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={threads}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
      onClose={() => {}}
        onStartComment={() => {}}
        focusRequest={{ id: 't1', nonce: 2 }}
      />,
    )
    expect(screen.getByRole('button', { name: 'resolved' }).className).toContain('font-medium')
  })

  test('an unchanged nonce across an unrelated re-render does not re-reveal (revealedRef property, preserved)', () => {
    const threads = [mkThread({ id: 't1', status: 'resolved' })]
    const { rerender } = renderRail(threads, { id: 't1', nonce: 1 })
    expect(screen.getByRole('button', { name: 'resolved' }).className).toContain('font-medium')

    // Manually switch back to 'open' — a re-render with the SAME nonce must not flip it back.
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByRole('button', { name: 'open' }).className).toContain('font-medium')

    rerender(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={threads}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
      onClose={() => {}}
        onStartComment={() => {}}
        focusRequest={{ id: 't1', nonce: 1 }}
      />,
    )
    expect(screen.getByRole('button', { name: 'open' }).className).toContain('font-medium')
  })

  test('a different id with a bumped nonce reveals', () => {
    const threads = [mkThread({ id: 't1', status: 'open' }), mkThread({ id: 't2', status: 'resolved' })]
    const { rerender } = renderRail(threads, { id: 't1', nonce: 1 })
    expect(screen.getByRole('button', { name: 'open' }).className).toContain('font-medium')

    rerender(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={threads}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
      onClose={() => {}}
        onStartComment={() => {}}
        focusRequest={{ id: 't2', nonce: 2 }}
      />,
    )
    expect(screen.getByRole('button', { name: 'resolved' }).className).toContain('font-medium')
  })

  // Regression: viewer.tsx used to build `focusRequest={{ id, nonce: 0 }}` as an inline object
  // literal, so every parent re-render handed this effect a NEW reference with the SAME id/nonce.
  // The effect was keyed on the `focusRequest` object itself, so it re-ran on every one of those —
  // its cleanup cancelled the pending rAF scroll, and the re-run then no-op'd on the unchanged
  // nonce, silently dropping the scroll forever. Fixed by keying the effect on the request's own
  // id/nonce primitives instead of the wrapper object, so identity churn from the caller can't
  // cancel a scroll that's already in flight.
  test('an equal-but-new focusRequest object (same id/nonce) does not drop the pending scroll', async () => {
    const threads = [mkThread({ id: 't1', status: 'open' })]
    const scrollSpy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    const { rerender } = renderRail(threads, { id: 't1', nonce: 1 })

    // A fresh object, same id/nonce — mirrors an inline `{ id, nonce }` literal recreated on an
    // unrelated parent re-render — arriving BEFORE the rAF from the initial render has fired.
    rerender(
      <ReviewRail
        site={SITE}
        me={ME}
        threads={threads}
        composing={null}
        onCancelComposer={() => {}}
        onCreate={() => {}}
        onCreateVoice={() => {}}
        onChanged={() => {}}
        onFocusAnchor={() => {}}
      onClose={() => {}}
        onStartComment={() => {}}
        focusRequest={{ id: 't1', nonce: 1 }}
      />,
    )

    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1))
    scrollSpy.mockRestore()
  })
})
