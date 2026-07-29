// B2c "viewer wiring" — the two behaviors the slice spec calls out by name that no test anywhere
// else touches (viewer.tsx is otherwise an intentionally-untested wiring shell; see badges.ts,
// prefetchArbiter.ts etc. for where the actual logic lives and is unit-tested):
//
//   1. the anchorRects handler measures the IFRAME'S OWN clientWidth/clientHeight at the moment a
//      batch arrives (not a hardcoded/default box) — that's what keeps lib/badges pure.
//   2. badge state resets to initialBadges() on splat navigation, so a chip pinned to the OLD
//      document's rect doesn't survive a same-site file change.
//
// Sidebar and command palette are stubbed to `null`: this test is scoped to the badge wiring plus
// (C2b) the rail-toggle/popover-independence wiring, not a full-viewer render — those two pieces
// have (or don't need) their own coverage. ViewerTopBar, CommentPopover and ReviewRail are
// deliberately NOT stubbed here (see note below the import) — badge-button queries are scoped to
// the iframe's own wrapper (badgeButtons below) so the rail's/topbar's real, visible buttons never
// leak into that count.
import { describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, type LoaderFunctionArgs, RouterProvider } from 'react-router'
import type { Thread } from '@/lib/comments'
import type { ViewerLoaderData } from '@/lib/viewerLoader'
import type { ViewerSite } from '@/lib/types'

// bun's mock.module swaps a specifier's resolution for the WHOLE process, and it's the module
// GRAPH LINKING (which runs across every test file before any test body executes) that reads it —
// not just this file's own test run — so an `afterAll` restore here is too late to save another
// file's static `import` of the same specifier. ViewerTopBar, CommentPopover and ReviewRail each
// have their own dedicated unit test (ViewerTopBar.test.tsx, CommentPopover.test.tsx,
// ReviewRail.test.tsx) that imports the real component directly; mocking any of them here to `null`
// would silently break every one of those tests process-wide (this is exactly what happened when
// ReviewRail.test.tsx was added in slice C1b — its renders came back an empty `<div />` because
// THIS file's mock.module had already run at import time). All three are left real and unmocked:
// ViewerTopBar is needed for real here (C2b's Comments-button-toggles-the-rail wiring has no other
// integration coverage — see the "rail toggle" describe block below); CommentPopover renders
// nothing observable in the badge tests (they leave chip/composer state null); ReviewRail's own
// buttons are kept out of this file's badge-button assertions by scoping them to the iframe's
// wrapper (badgeButtons below).
mock.module('@/components/ViewerSidebar', () => ({ ViewerSidebar: () => null }))
mock.module('@/components/CommandPalette', () => ({ CommandPalette: () => null }))

const { Component } = await import('./viewer')

// The real component renders a real <iframe src="https://content.example.com/...">; without this,
// happy-dom actually tries to fetch it over the network on every render, which is slow and noisy
// (and would be outright flaky off-VPN/offline). Nothing in this file depends on iframe navigation
// — only on the element's contentWindow (for message `source`) and its measured box (stubbed below).
;(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true

const SITE: ViewerSite = {
  id: 's1',
  spaceSlug: 'sp',
  siteSlug: 'site',
  title: 'T',
  visibility: 'public',
  status: 'active',
  isOwner: true,
  contentUrl: 'https://content.example.com/sp/site/',
  indexPath: 'index.html',
}
const CONTENT_ORIGIN = 'https://content.example.com'

function mkThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    id: overrides.id,
    filePath: 'index.html',
    anchorType: 'text',
    quote: 'q',
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

const THREADS: Thread[] = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
// A different file's threads, disjoint ids from THREADS — mirrors production (comments.list scopes
// by path, so two files never share a thread id) and is what makes the epoch-regression bug in the
// splat-nav test observable: an id-based filter alone can't catch a stale badge epoch.
const OTHER_THREADS: Thread[] = [mkThread({ id: 't3', filePath: 'other.html' })]

// Bypasses the real loader (network) entirely — the router feeds the component exactly the
// ViewerLoaderData shape it expects, same as loadViewer would once site meta resolves. Path-aware
// so the splat-nav test can drive the component to a genuinely different file.
function makeLoaderData({ params }: LoaderFunctionArgs): ViewerLoaderData {
  const sitePath = params['*'] ?? ''
  if (sitePath === 'other.html') return { site: SITE, entryPath: 'other.html', commentsPromise: Promise.resolve(OTHER_THREADS) }
  return { site: SITE, entryPath: 'index.html', commentsPromise: Promise.resolve(THREADS) }
}

function renderViewer(initialPath: string) {
  const router = createMemoryRouter([{ path: '/:space/:site/*', Component, loader: makeLoaderData }], {
    initialEntries: [initialPath],
  })
  const utils = render(<RouterProvider router={router} />)
  return { ...utils, router }
}

// Arms the iframe with a real (test-chosen) box and returns it plus the message-sending helper —
// `source` must be the SAME window object parseIntent compares against (iframeRef.current
// .contentWindow), and `origin` must match the site's content origin, or the message is dropped.
function armIframe(container: HTMLElement) {
  const iframe = container.querySelector('iframe') as HTMLIFrameElement
  Object.defineProperty(iframe, 'clientWidth', { value: 100, configurable: true })
  Object.defineProperty(iframe, 'clientHeight', { value: 50, configurable: true })
  const send = (data: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: CONTENT_ORIGIN, source: iframe.contentWindow }))
  }
  return { iframe, send }
}

// Badge buttons live in the iframe's own wrapper div (BadgeOverlay is its sibling, per viewer.tsx);
// ReviewRail — now real and unmocked — renders its OWN buttons (filter tabs, "Add comment") in a
// sibling `<aside>` outside that wrapper, so scoping here is what keeps this file's badge-count
// assertions from silently counting the rail's chrome too.
function badgeButtons(iframe: HTMLIFrameElement) {
  return within(iframe.parentElement as HTMLElement).queryAllByRole('button')
}

describe('viewer wiring — badge overlay', () => {
  test('anchorRects filters offscreen rects against the IFRAME\'S OWN measured box, not a default', async () => {
    const { container } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send } = armIframe(container)

    // Confirm the provisional HTML prefetch against the iframe's real path so `threads` populates —
    // otherwise every rect below is dropped for "no matching thread" before offscreen even runs.
    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    await waitFor(() => expect(badgeButtons(iframe)).toHaveLength(0)) // no rects yet, but ready applied

    // t1 sits well inside the iframe's real 100x50 box; t2 sits well outside it — but comfortably
    // inside any plausible hardcoded default (e.g. 800x600). Only measuring the real box yields
    // exactly one visible badge; any hardcoded viewport yields zero (default {0,0} fallback) or two.
    act(() =>
      send({
        type: 'glance:anchor-rects',
        epoch: 0,
        rects: [
          { id: 't1', rect: { top: 10, left: 10, width: 5, height: 5 } },
          { id: 't2', rect: { top: 200, left: 200, width: 5, height: 5 } },
        ],
      }),
    )

    const buttons = await waitFor(() => {
      const btns = badgeButtons(iframe)
      expect(btns).toHaveLength(1)
      return btns
    })
    expect((buttons[0] as HTMLElement).style.top).toBe('10px')
    expect((buttons[0] as HTMLElement).style.left).toBe('15px') // first.rect.left + first.rect.width
  })

  // buildBadges already drops a rect whose id has no matching CURRENT thread, so a stale rect alone
  // never renders a visible chip for the new document (ids never collide across files in
  // production) — that isn't the bug this pins. The real failure mode is the badge EPOCH: several
  // reflow frames on the old document push it well above 0, and a fresh iframe's own reflow always
  // restarts counting at 0. Without the reset, stepBadges' "a lower epoch is stale, drop it" guard
  // (lib/badges.ts) mistakes the NEW document's first-ever batch for a stale replay of the old one
  // and drops it forever — the new page's comments simply never grow a badge.
  test('splat navigation resets the badge epoch, so the new document\'s first batch is not mistaken for a stale replay', async () => {
    const { container, router } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send } = armIframe(container)

    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    // Several reflow frames on the OLD document, ending well above epoch 0.
    act(() => send({ type: 'glance:anchor-rects', epoch: 5, rects: [{ id: 't1', rect: { top: 10, left: 10, width: 5, height: 5 } }] }))
    await waitFor(() => expect(badgeButtons(iframe)).toHaveLength(1))

    // Same site, different splat — the exact nav the reset guards (a cross-site nav would instead
    // remount via the Component key, never reaching this branch).
    await act(async () => {
      await router.navigate('/sp/site/other.html?review=1')
    })
    act(() => send({ type: 'glance:ready', filePath: 'other.html' }))
    await waitFor(() => expect(badgeButtons(iframe)).toHaveLength(0)) // threads reset, no rects yet

    // The NEW iframe's own first reflow frame — always epoch 0.
    act(() => send({ type: 'glance:anchor-rects', epoch: 0, rects: [{ id: 't3', rect: { top: 10, left: 10, width: 5, height: 5 } }] }))

    await waitFor(() => expect(badgeButtons(iframe)).toHaveLength(1))
  })

  // C2b: badges are unconditional now — nothing gates the overlay (or the anchorRects handler
  // feeding it) on `railOpen`. Renders WITHOUT `?review=1`/`?rail=1`, so the rail panel is never
  // opened, and still expects a real badge for a real thread.
  test('the badge overlay renders a real badge with the rail CLOSED — nothing gates it on railOpen', async () => {
    const { container } = renderViewer('/sp/site')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send } = armIframe(container)

    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    act(() =>
      send({
        type: 'glance:anchor-rects',
        epoch: 0,
        rects: [{ id: 't1', rect: { top: 10, left: 10, width: 5, height: 5 } }],
      }),
    )

    await waitFor(() => expect(badgeButtons(iframe)).toHaveLength(1))
    // The rail panel itself must still be absent — badges don't imply the panel opened.
    expect(container.querySelector('aside')).toBeNull()
  })

  // C2b: paint is unconditional too — the mutation-check for this slice found that re-gating
  // `anchors: railOpen ? paintAnchors(threads) : []` left the whole suite green, because nothing
  // asserted on the actual glance:paint POST (only on badges fed by a hand-injected anchor-rects
  // message, which never exercises paint at all). Spying on the iframe's own postMessage is what
  // proves painting itself — not just the badge overlay it eventually feeds — fires unconditionally.
  test('painting posts real anchors to the iframe with the rail CLOSED — not just an empty array', async () => {
    const { container } = renderViewer('/sp/site')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    // happy-dom's real contentWindow is null with iframe page loading disabled (see the top-of-file
    // note), so `paint()`'s `if (!win) return` would swallow every postMessage before it happens —
    // a fake contentWindow is the only way to observe the parent→child channel at all in this
    // harness. Must be set BEFORE 'ready' below: viewer.tsx re-reads iframeRef.current.contentWindow
    // fresh on every paint, so it's the value in place when threads first populate that matters.
    const posted: unknown[] = []
    const fakeWin = { postMessage: (m: unknown) => posted.push(m) }
    Object.defineProperty(iframe, 'contentWindow', { value: fakeWin, configurable: true })
    const send = (data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data, origin: CONTENT_ORIGIN, source: iframe.contentWindow as unknown as Window }))

    act(() => send({ type: 'glance:ready', filePath: 'index.html' })) // applies THREADS (t1, t2)

    await waitFor(() => {
      const paints = posted.filter((m) => (m as { type?: string }).type === 'glance:paint')
      expect(paints.length).toBeGreaterThan(0)
    })
    const lastPaint = posted.filter((m) => (m as { type?: string }).type === 'glance:paint').at(-1) as {
      anchors: { id: string }[]
    }
    expect(lastPaint.anchors.map((a) => a.id).sort()).toEqual(['t1', 't2'])
    expect(container.querySelector('aside') === null).toBe(true) // rail never opened
  })
})

// C1: a badge click is the second reveal SOURCE (the notification deep link is the first), and the
// only one that can re-request the SAME thread — which is what ReviewRail's nonce guard exists for.
// Both tests drive the real BadgeOverlay and the real ReviewRail; the reveal is observed as the
// thread's own card (`#thread-<id>`, ThreadCard's root) being in the document.
describe('viewer wiring — badge click reveal (C1)', () => {
  // Arms the iframe, applies THREADS, injects one rect for `id` and returns its rendered chip.
  async function badgeFor(container: HTMLElement, id: string) {
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send } = armIframe(container)
    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    act(() => send({ type: 'glance:anchor-rects', epoch: 0, rects: [{ id, rect: { top: 10, left: 10, width: 5, height: 5 } }] }))
    return await waitFor(() => {
      const btns = badgeButtons(iframe)
      expect(btns).toHaveLength(1)
      return btns[0]
    })
  }

  // With the rail CLOSED a badge is the only comment affordance on screen, so a click that merely
  // scrolls the iframe (onOpen's original scrollAnchor-only body) moves the page and shows the user
  // no comment at all — the thread it points at is unreachable.
  test('a badge click opens the closed rail and reveals the clicked thread', async () => {
    const { container } = renderViewer('/sp/site')
    const badge = await badgeFor(container, 't1')
    expect(container.querySelector('aside') === null).toBe(true) // rail closed: the click must open it

    fireEvent.click(badge)

    await waitFor(() => expect(container.querySelector('aside')).not.toBeNull())
    expect(document.getElementById('thread-t1')).not.toBeNull()
  })

  // "Unfiltered" reveal: the rail's status tabs are user state, so the thread a badge points at can
  // be sitting behind the tab that ISN'T selected. Revealing has to move the tab to the target's own
  // status (ReviewRail's setFilter(target.status)), or the click opens a rail that doesn't contain
  // it. Round two re-clicks the SAME badge, which is what the nonce buys: with a constant nonce
  // ReviewRail treats the repeat as already-handled and the card never comes back.
  test('a badge click reveals its thread even when the rail is filtered away from it, on every click', async () => {
    const { container } = renderViewer('/sp/site?review=1')
    const badge = await badgeFor(container, 't1')
    await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())

    for (const _round of [1, 2]) {
      // t1 is open, so the resolved tab hides its card — the state a reveal has to punch through.
      fireEvent.click(screen.getByRole('button', { name: 'resolved' }))
      await waitFor(() => expect(document.getElementById('thread-t1')).toBeNull())

      fireEvent.click(badge)

      await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())
    }
  })
})

describe('viewer wiring — rail toggle (C2b: the rail is just a panel, not a review-mode gate)', () => {
  // C2b's mutation-check found `toggleRail = () => setRailOpen(true)` (never closes) and
  // `onClose={() => {}}` both survive the whole suite green: ViewerTopBar.test.tsx only asserts the
  // callback FIRES, and ReviewRail.test.tsx only asserts the same for onClose — neither proves the
  // actual DOM effect. ViewerTopBar was left unmocked in this file specifically to close that hole:
  // a real click on the real Comments button, observing the real <aside> appear and disappear.
  test('the Comments button opens the rail panel, and clicking it again closes it', async () => {
    const { container } = renderViewer('/sp/site')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    // Boolean, not a direct node assertion: a FAILING node assertion here would pretty-print the
    // whole rendered tree (ReviewRail's threads, Composer, mention menu, …) into the failure
    // message — cheap when green, but an expensive way to fail red under a real regression.
    expect(container.querySelector('aside') === null).toBe(true)

    const button = screen.getByRole('button', { name: /Comments/ })
    fireEvent.click(button)
    await waitFor(() => expect(container.querySelector('aside') === null).toBe(false))

    fireEvent.click(button)
    await waitFor(() => expect(container.querySelector('aside') === null).toBe(true))
  })

  test("the rail's own ✕ closes it too, the other way in besides the Comments toggle", async () => {
    const { container } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('aside') === null).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Close comments' }))
    await waitFor(() => expect(container.querySelector('aside') === null).toBe(true))
  })

  // Regression: closeRail used to carry over the old exitReview teardown wholesale, including
  // `dispatchPopover({ type: 'dismiss' })` — harmless while the popover was ALSO gated on review
  // (closing review unmounted it anyway), but now that the popover is unconditional (C2b) that same
  // call tears down an unrelated in-progress draft just because the user closed the rail panel.
  test('closing the rail does NOT dismiss an open selection popover — they are decoupled (C2b)', async () => {
    const { container } = renderViewer('/sp/site')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { send } = armIframe(container)
    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))

    act(() => send({ type: 'glance:select', quote: 'hello', rect: { top: 5, left: 5, width: 10, height: 10 } }))
    const chip = await screen.findByRole('button', { name: 'Comment on selection' })
    fireEvent.click(chip) // 'activate' — opens the composer over this quote
    await screen.findByText((t) => t.includes('hello'))

    // Open then close the rail via the Comments toggle — the popover lives in a wholly separate
    // wrapper and must not react to it at all.
    const commentsButton = screen.getByRole('button', { name: /Comments/ })
    fireEvent.click(commentsButton)
    await waitFor(() => expect(container.querySelector('aside') === null).toBe(false))
    fireEvent.click(commentsButton)
    await waitFor(() => expect(container.querySelector('aside') === null).toBe(true))

    expect(screen.queryByText((t) => t.includes('hello')) !== null).toBe(true)
  })
})
