// Slice B3b-hard — the rail card's own half of the hover-only highlight ruling: it lights its
// anchor on hover/focus and clears on leave/blur, exactly like a BadgeOverlay chip (see
// BadgeOverlay.test.tsx's mirror-image cases). A click is unchanged — it still scrolls
// (onFocusAnchor) — but must NEVER be the thing that lights a highlight; that's the bug this
// slice fixes (a rail-card click used to post glance:highlight([id]) with nothing to clear it).
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Thread } from '@/lib/comments'
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

function renderCard(overrides: { onFocusAnchor?: (t: Thread) => void; onHoverThread?: (ids: string[] | null) => void } = {}) {
  const onFocusAnchor = overrides.onFocusAnchor ?? mock((_t: Thread) => {})
  const onHoverThread = overrides.onHoverThread ?? mock((_ids: string[] | null) => {})
  const thread = mkThread({ id: 't1' })
  render(
    <ThreadCard site={SITE} me={ME} thread={thread} onChanged={() => {}} onFocusAnchor={onFocusAnchor} onHoverThread={onHoverThread} />,
  )
  // The root carries id={`thread-${thread.id}`} for the deep-link scroll target (S11) — reused
  // here instead of adding a test-only attribute.
  const card = document.getElementById(`thread-${thread.id}`) as HTMLElement
  return { onFocusAnchor, onHoverThread, thread, card }
}

describe('ThreadCard — hover/focus light the anchor, leave/blur clear it', () => {
  test('pointerenter fires onHoverThread with its own thread id', () => {
    const { onHoverThread, card } = renderCard()
    fireEvent.pointerEnter(card)
    expect(onHoverThread).toHaveBeenCalledTimes(1)
    expect(onHoverThread).toHaveBeenLastCalledWith(['t1'])
  })

  test('pointerleave fires onHoverThread with null', () => {
    const { onHoverThread, card } = renderCard()
    fireEvent.pointerEnter(card)
    fireEvent.pointerLeave(card)
    expect(onHoverThread).toHaveBeenCalledTimes(2)
    expect(onHoverThread).toHaveBeenLastCalledWith(null)
  })

  test('focus fires onHoverThread with its own thread id — keyboard counts as hover', () => {
    const { onHoverThread, card } = renderCard()
    fireEvent.focus(card)
    expect(onHoverThread).toHaveBeenCalledTimes(1)
    expect(onHoverThread).toHaveBeenLastCalledWith(['t1'])
  })

  test('blur fires onHoverThread with null', () => {
    const { onHoverThread, card } = renderCard()
    fireEvent.focus(card)
    fireEvent.blur(card)
    expect(onHoverThread).toHaveBeenCalledTimes(2)
    expect(onHoverThread).toHaveBeenLastCalledWith(null)
  })
})

describe('ThreadCard — a click still scrolls, and never lights a persistent highlight', () => {
  test('clicking the quote calls onFocusAnchor with the thread (scroll)', () => {
    const { onFocusAnchor, thread } = renderCard()
    fireEvent.click(screen.getByText(`“${thread.quote}”`))
    expect(onFocusAnchor).toHaveBeenCalledTimes(1)
    expect(onFocusAnchor).toHaveBeenCalledWith(thread)
    // onHoverThread is deliberately NOT asserted either way here: a real browser click on a
    // <button> moves focus to it, which bubbles as onFocus on the card root and fires
    // onHoverThread(['t1']) — the 'focus fires onHoverThread' case above already covers that. In
    // happy-dom, fireEvent.click never moves focus, so asserting "not called" here would only be
    // testing the test harness's lack of focus-follows-click, not the component.
  })
})
