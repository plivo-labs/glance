// "viewer wiring" — the behaviours that live ONLY in viewer.tsx's wiring and no unit test anywhere
// else touches (viewer.tsx is otherwise an intentionally-untested shell; see prefetchArbiter.ts etc.
// for where the actual logic lives):
//
//   1. the glance:paint post is gated on railOpen — real anchors when the panel is open, an EMPTY
//      list when it isn't, which is what makes the on-page highlights appear and disappear with it.
//   2. a glance:anchor-click from the iframe reveals that thread in the rail, every time.
//   3. adding a comment OPENS the rail (and shows no toast standing in for it).
//
// Sidebar and command palette are stubbed to `null`: this test is scoped to that wiring, not a
// full-viewer render. ViewerTopBar, CommentPopover and ReviewRail are deliberately NOT stubbed
// (see note below the import).
import { describe, expect, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, type LoaderFunctionArgs, RouterProvider } from 'react-router'
import { comments, type Thread } from '@/lib/comments'
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
// integration coverage — see the "rail toggle" describe block below), and so are CommentPopover
// (the add-a-comment flow is driven through its real chip and composer) and ReviewRail (a reveal is
// observed as the thread's own card appearing in it).
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

// Bypasses the real loader (network) entirely — the router feeds the component exactly the
// ViewerLoaderData shape it expects, same as loadViewer would once site meta resolves.
function makeLoaderData(_args: LoaderFunctionArgs): ViewerLoaderData {
  return { site: SITE, entryPath: 'index.html', commentsPromise: Promise.resolve(THREADS) }
}

function renderViewer(initialPath: string) {
  const router = createMemoryRouter([{ path: '/:space/:site/*', Component, loader: makeLoaderData }], {
    initialEntries: [initialPath],
  })
  return render(<RouterProvider router={router} />)
}

// Arms the iframe with a FAKE contentWindow that records every parent→child post. happy-dom's real
// contentWindow is null with iframe page loading disabled (see the top-of-file note), so paint()'s
// `if (!win) return` would swallow every postMessage before it happened — a fake is the only way to
// observe the parent→child channel at all in this harness. Must be installed BEFORE 'ready':
// viewer.tsx re-reads iframeRef.current.contentWindow fresh on every paint.
function armIframe(container: HTMLElement) {
  const iframe = container.querySelector('iframe') as HTMLIFrameElement
  const posted: unknown[] = []
  const fakeWin = { postMessage: (m: unknown) => posted.push(m) }
  Object.defineProperty(iframe, 'contentWindow', { value: fakeWin, configurable: true })
  // `source` must be the SAME object parseIntent compares against, and `origin` must match the
  // site's content origin, or the message is dropped.
  const send = (data: unknown) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin: CONTENT_ORIGIN, source: iframe.contentWindow as unknown as Window }))
  const paints = () => posted.filter((m) => (m as { type?: string }).type === 'glance:paint') as { anchors: { id: string }[] }[]
  const lastPaintIds = () => (paints().at(-1)?.anchors ?? []).map((a) => a.id).sort()
  return { iframe, send, paints, lastPaintIds }
}

// The iframe only boots its message listener on load; viewer.tsx gates paint on the same `loaded`
// flag, so nothing is ever posted until this fires.
const loadIframe = (iframe: HTMLIFrameElement) => act(() => void fireEvent.load(iframe))

describe('viewer wiring — the paint is gated on railOpen (the on-page highlights)', () => {
  // A paint IS the highlight now (annotate/client.ts lights everything it is sent), so this ONE
  // post is the whole feature: real anchors while the panel is open, an empty list when it isn't.
  // Both directions from one render — a `railOpen &&` that only ever ADDS anchors would pass the
  // open half and fail the close half, and a paint left unconditional fails the first assertion.
  test('empty while the rail is CLOSED, real anchors once it opens, empty again when it closes', async () => {
    const { container } = renderViewer('/sp/site')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send, paints, lastPaintIds } = armIframe(container)
    loadIframe(iframe)

    act(() => send({ type: 'glance:ready', filePath: 'index.html' })) // applies THREADS (t1, t2)

    expect(container.querySelector('aside')).toBeNull() // rail closed
    await waitFor(() => expect(paints().length).toBeGreaterThan(0))
    expect(lastPaintIds()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    await waitFor(() => expect(lastPaintIds()).toEqual(['t1', 't2']))

    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    await waitFor(() => expect(lastPaintIds()).toEqual([]))
  })

  // `?review=1` (a notification link) opens the rail before the frame has loaded and before threads
  // are in. The client's listener isn't wired until load, so a paint posted earlier is dropped on
  // the floor with nothing to re-fire it — which is why `loaded` is a DEPENDENCY of paint, not just
  // a guard inside it. Without that, this deep link lands on a rail full of comments and a page
  // with no highlights at all.
  test('a ?review=1 deep link still paints once the frame finishes loading', async () => {
    const { container } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send, lastPaintIds } = armIframe(container)

    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    await waitFor(() => expect(container.querySelector('aside')).not.toBeNull()) // rail open, not loaded yet

    loadIframe(iframe)

    await waitFor(() => expect(lastPaintIds()).toEqual(['t1', 't2']))
  })
})

// Clicking a highlight in the page is the ONLY route from the document back to the rail now that
// badges are gone. The reveal is observed as the thread's own card (`#thread-<id>`, ThreadCard's
// root) being in the document.
describe('viewer wiring — a click on a painted anchor reveals its thread', () => {
  // "Unfiltered" reveal: the rail's status tabs are user state, so the thread a highlight belongs to
  // can be sitting behind the tab that ISN'T selected. Revealing has to move the tab to the target's
  // own status (ReviewRail's setFilter(target.status)), or the click opens a rail that doesn't
  // contain it. Round two clicks the SAME anchor, which is what the nonce buys: with a constant
  // nonce ReviewRail treats the repeat as already-handled and the card never comes back.
  test('reveals its thread even when the rail is filtered away from it, on every click', async () => {
    const { container } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send } = armIframe(container)
    loadIframe(iframe)
    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())

    for (const _round of [1, 2]) {
      // t1 is open, so the resolved tab hides its card — the state a reveal has to punch through.
      fireEvent.click(screen.getByRole('button', { name: 'resolved' }))
      await waitFor(() => expect(document.getElementById('thread-t1')).toBeNull())

      act(() => send({ type: 'glance:anchor-click', id: 't1' }))

      await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())
    }
  })

  // The id crosses the hostile-iframe boundary, so it is looked up in the parent's OWN threads
  // rather than trusted. A forged one matches nothing and must reveal nothing — not open the rail
  // on an empty request, and not throw.
  test('an id matching no loaded thread reveals nothing', async () => {
    const { container } = renderViewer('/sp/site')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { iframe, send } = armIframe(container)
    loadIframe(iframe)
    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))

    act(() => send({ type: 'glance:anchor-click', id: 'ghost' }))

    expect(container.querySelector('aside')).toBeNull()
  })
})

// Adding a comment OPENS the rail — always, and with no toast standing in for it. The old behaviour
// (leave the panel shut, toast "Comment added" with a "Show comments" action) is what this replaces,
// so both halves are asserted: the <aside> appears, and no toast does.
describe('viewer wiring — adding a comment opens the rail', () => {
  test('a comment written from the in-page popover opens the rail, with no toast', async () => {
    const create = spyOn(comments, 'create').mockResolvedValue(mkThread({ id: 't9' }))
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const mentionable = spyOn(comments, 'mentionable').mockResolvedValue([])
    try {
      const { container } = renderViewer('/sp/site')
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const { iframe, send } = armIframe(container)
      loadIframe(iframe)
      act(() => send({ type: 'glance:ready', filePath: 'index.html' })) // gives submitThread its filePath
      expect(container.querySelector('aside')).toBeNull() // rail closed

      // Select text in the page → chip → composer, the real in-place comment path.
      act(() => send({ type: 'glance:select', quote: 'the quoted sentence', rect: { top: 10, left: 10, width: 50, height: 12 } }))
      fireEvent.click(await screen.findByRole('button', { name: 'Comment on selection' }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'this paragraph contradicts the last' } })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
      })

      expect(create).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(container.querySelector('aside')).not.toBeNull())
      expect(screen.queryByText('Comment added')).toBeNull()
    } finally {
      create.mockRestore()
      list.mockRestore()
      mentionable.mockRestore()
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
