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
import { afterAll, beforeEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
// ViewerLoaderData shape it expects, same as loadViewer would once site meta resolves. Keyed off
// the route params rather than pinned to SITE, so navigating to a second site yields THAT site's
// meta — which is what the socket the viewer dials is built from.
function makeLoaderData({ params }: LoaderFunctionArgs): ViewerLoaderData {
  const site: ViewerSite =
    params.site === SITE.siteSlug
      ? SITE
      : { ...SITE, id: `s-${params.site}`, siteSlug: params.site ?? '', contentUrl: `${CONTENT_ORIGIN}/${params.space}/${params.site}/` }
  return { site, entryPath: 'index.html', commentsPromise: Promise.resolve(THREADS) }
}

function renderViewer(initialPath: string) {
  const router = createMemoryRouter([{ path: '/:space/:site/*', Component, loader: makeLoaderData }], {
    initialEntries: [initialPath],
  })
  return { ...render(<RouterProvider router={router} />), router }
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

// S9: the viewer now opens a real comments socket on mount (lib/commentStream). It is stood in for
// at the WebSocket GLOBAL, not with mock.module — mocking the module is process-wide (see the note
// above) and would blind commentStream.test.ts's own import of the real thing. The global is
// restored afterwards so nothing outside this file inherits the fake.
const sockets: FakeSocket[] = []
class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  /** Rail → room: what this viewer actually put on the wire (typing pings, S11). */
  sent: string[] = []
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    sockets.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
}
const realWebSocket = globalThis.WebSocket
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
afterAll(() => {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket
})
beforeEach(() => {
  sockets.length = 0
})

/** The socket the mounted viewer dialled — awaited, since the dial happens in a mount effect. */
const dialledSocket = () =>
  waitFor(() => {
    const s = sockets.at(-1)
    if (!s) throw new Error('no socket dialled')
    return s
  })
/** Server → viewer: one comments-channel frame, exactly as the DO fans it out. */
const pushFrame = (socket: FakeSocket, event: object) =>
  act(() => void socket.onmessage?.({ data: JSON.stringify({ channel: 'comments', ...event }) }))

/** "no card with this id" — never `expect(node).toBeNull()` for the negative case.
 *  When that form FAILS the received value is a React-attached happy-dom node and bun's
 *  pretty-printer walks the entire window off it: breaking applyCommentEvent's file filter produced
 *  66 MB of serialized happy-dom globals and still no verdict at 90 s. CI reads that as a timeout
 *  rather than a red — the assertion meant to catch the regression is what buries it. Comparing
 *  STRINGS keeps the failure one line long and still names which thread showed up. */
const expectNoCard = (id: string) =>
  expect(`${id}: ${document.getElementById(`thread-${id}`) ? 'present' : 'absent'}`).toBe(`${id}: absent`)

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

// #112 — the whole bug was one wiring line here: `onStartComment={isAudio ? startPageComment :
// undefined}`, which handed the rail its page-comment trigger only on the audio view. SITE in this
// file is an HTML page (index.html), so this is the non-audio case the gate excluded, driven
// through the real rail and the real composer. Nothing below would survive re-adding the isAudio
// gate: the button simply wouldn't render.
describe('viewer wiring — a page comment can be written from a non-audio view (#112)', () => {
  test('the rail\'s "Add comment" creates a page-anchored thread — anchorType page, no quote', async () => {
    const create = spyOn(comments, 'create').mockResolvedValue(mkThread({ id: 'p1', anchorType: 'page', quote: null }))
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const mentionable = spyOn(comments, 'mentionable').mockResolvedValue([])
    try {
      const { container } = renderViewer('/sp/site?review=1')
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const { iframe, send } = armIframe(container)
      loadIframe(iframe)
      act(() => send({ type: 'glance:ready', filePath: 'index.html' })) // gives submitThread its filePath

      // No text selection anywhere in this test — that is the point of a page comment.
      fireEvent.click(await screen.findByRole('button', { name: 'Add comment' }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'this chart is wrong' } })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
      })

      expect(create).toHaveBeenCalledTimes(1)
      const input = create.mock.calls[0]![1]
      expect(input).toEqual({ filePath: 'index.html', body: 'this chart is wrong', anchorType: 'page' })
      // Explicit, not implied by toEqual: a page thread must carry NO quote at all — sending an
      // empty-string quote would make the server treat it as a text anchor it can never re-find.
      expect(input).not.toHaveProperty('quote')
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

// ── S9: the rail listens instead of asking again ───────────────────────────────────────────────
// Phase 1+2 push comment events over the site's comments socket; S7 (applyCommentEvent) folds one
// into a list and S8 (commentStream) carries them. This is the wiring that makes a comment written
// in another browser appear here — and that deletes the refetch the write used to depend on.
describe('viewer wiring — pushed comment events (S9)', () => {
  const mkComment = (id: string, body: string) => ({
    id,
    authorId: 'u2',
    author: 'Riya',
    body,
    deleted: false,
    reactions: [],
    createdAt: '2024-01-02',
    editedAt: null,
  })

  // Drives a viewer to "rail open, index.html confirmed, THREADS painted" — the state every push
  // below lands on. The list spy counts REFETCHES: the loader's prefetch is its own promise, so
  // comments.list is only ever reached by a refresh.
  async function mounted(list: ReturnType<typeof spyOn<typeof comments, 'list'>>) {
    const { container, unmount, router } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const armed = armIframe(container)
    loadIframe(armed.iframe)
    act(() => armed.send({ type: 'glance:ready', filePath: 'index.html' }))
    await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())
    expect(list).not.toHaveBeenCalled()
    const socket = await dialledSocket()
    act(() => socket.onopen?.())
    return { container, unmount, socket, router, ...armed }
  }

  // The dial's INPUTS, not just that one happened: a wrong site would subscribe this rail to another
  // site's room (someone else's comments, and none of ours), and a wrong origin would talk to a
  // different server entirely. Both are silent failures everywhere else in this file.
  test('the socket is dialled at THIS site’s comments room, on the app’s own origin', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket } = await mounted(list)
      expect(socket.url).toBe(`${window.location.origin.replace(/^http/, 'ws')}/api/sites/sp/site/comments/socket`)
    } finally {
      list.mockRestore()
    }
  })

  test('a pushed thread.created for this file appears — no refetch, and the page repaints from it', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket, lastPaintIds, paints } = await mounted(list)
      await waitFor(() => expect(lastPaintIds()).toEqual(['t1', 't2']))
      const before = paints().length

      await pushFrame(socket, { type: 'thread.created', siteId: 's1', filePath: 'index.html', thread: mkThread({ id: 't3' }) })

      await waitFor(() => expect(document.getElementById('thread-t3')).not.toBeNull())
      // Chips repaint for FREE: `paint` derives from `threads`, so the push feeds the existing paint
      // path and no second one exists — one more post, carrying the pushed anchor.
      await waitFor(() => expect(lastPaintIds()).toEqual(['t1', 't2', 't3']))
      expect(paints().length).toBe(before + 1)
      expect(list).not.toHaveBeenCalled()

      // C16's other half: the iframe learns "highlight this text" and NOTHING else. The pushed
      // thread reaches the page through paintAnchors' whitelist, same as a fetched one — a push
      // path that spread the thread object instead would ship the author's name and comment bodies
      // into the content origin, which is a different trust boundary from the rail.
      const pushed = paints().at(-1)!.anchors.find((a) => a.id === 't3')!
      expect(Object.keys(pushed).sort()).toEqual(['anchorType', 'context', 'id', 'quote'])
    } finally {
      list.mockRestore()
    }
  })

  test('a pushed reply appends to the thread it belongs to', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket } = await mounted(list)

      await pushFrame(socket, {
        type: 'comment.created',
        siteId: 's1',
        filePath: 'index.html',
        threadId: 't1',
        comment: mkComment('c9', 'a reply from another browser'),
      })

      await waitFor(() => expect(screen.queryByText('a reply from another browser')).not.toBeNull())
      expect(list).not.toHaveBeenCalled()
    } finally {
      list.mockRestore()
    }
  })

  // The DO room is per SITE; this rail is per FILE. Two viewers on two files of one site share the
  // socket, so the filter is the only thing keeping the other file's comments out of this list.
  test('a push for a DIFFERENT filePath changes nothing here', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket, lastPaintIds } = await mounted(list)

      await pushFrame(socket, {
        type: 'thread.created',
        siteId: 's1',
        filePath: 'other.html',
        thread: mkThread({ id: 'other1', filePath: 'other.html' }),
      })

      expectNoCard('other1')
      expect(lastPaintIds()).toEqual(['t1', 't2'])
    } finally {
      list.mockRestore()
    }
  })

  // The socket is per SITE and deliberately never redials on an in-iframe file change, so the file
  // a live push is matched against comes from a ref that has to KEEP UP with the navigation. A ref
  // frozen at mount looks identical on the first file and silently drops every comment on the next.
  test('after an in-iframe navigation, a live push for the NEW file lands — and one for the old does not', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue([mkThread({ id: 'p2a', filePath: 'page2.html' })])
    try {
      const { socket, send } = await mounted(list)
      act(() => send({ type: 'glance:ready', filePath: 'page2.html' })) // in-iframe nav → refetch, settled
      await waitFor(() => expect(document.getElementById('thread-p2a')).not.toBeNull())

      await pushFrame(socket, { type: 'thread.created', siteId: 's1', filePath: 'index.html', thread: mkThread({ id: 'old1' }) })
      await pushFrame(socket, {
        type: 'thread.created',
        siteId: 's1',
        filePath: 'page2.html',
        thread: mkThread({ id: 'p2b', filePath: 'page2.html' }),
      })

      await waitFor(() => expect(document.getElementById('thread-p2b')).not.toBeNull())
      expectNoCard('old1') // the file we LEFT is another file now
    } finally {
      list.mockRestore()
    }
  })

  // C13 — the race that silently loses a comment. An in-iframe navigation orders a fresh list; a
  // push landing while that read is in flight must not be applied to the list it is about to
  // replace, and must not be dropped either: it is buffered and folded into what the read returns.
  test('a push arriving while a list load is IN FLIGHT is buffered, then applied to the settled list', async () => {
    // Every read is captured as its OWN deferred rather than a single rolling `settle` resolver: a
    // second, unexpected read would otherwise silently steal the resolver, leaving the read this
    // test settles a stale generation the arbiter ignores — the buffer would never drain and the
    // final waitFor would spin instead of failing. `reads` is asserted, so an extra one is a
    // failure with a name, and the promise settled below is unambiguously the one being tested.
    const reads: { path: string; settle: (threads: Thread[]) => void }[] = []
    const list = spyOn(comments, 'list').mockImplementation(
      (_site, path) =>
        new Promise<Thread[]>((resolve) => {
          reads.push({ path, settle: resolve })
        }),
    )
    try {
      const { socket, send } = await mounted(list)

      act(() => send({ type: 'glance:ready', filePath: 'page2.html' })) // in-iframe nav → refetch
      await waitFor(() => expect(reads).toHaveLength(1))
      expect(reads[0]!.path).toBe('page2.html')

      await pushFrame(socket, {
        type: 'thread.created',
        siteId: 's1',
        filePath: 'page2.html',
        thread: mkThread({ id: 'pushed1', filePath: 'page2.html' }),
      })
      // Held: applying it now would paint it onto the OLD file's list, which this read replaces.
      expectNoCard('pushed1')

      await act(async () => {
        reads[0]!.settle([mkThread({ id: 'p2a', filePath: 'page2.html' })]) // the server's answer, minus the push
      })

      expect(reads).toHaveLength(1) // nothing else read the list — this settle IS the current one
      await waitFor(() => expect(document.getElementById('thread-pushed1')).not.toBeNull())
      expect(document.getElementById('thread-p2a')).not.toBeNull() // the settled list survives too
      expectNoCard('t1') // ...and the old file's does not
    } finally {
      list.mockRestore()
    }
  })

  /** Drop the socket and bring its redial up — the gap onReconnect exists to close. The redial
   *  delay is commentStream's own (and pinned there); fake timers only skip the wait. Advanced past
   *  the first backoff step INCLUDING its jitter (3s + up to 25%), so this never races the random. */
  async function reconnect(socket: FakeSocket) {
    jest.useFakeTimers()
    act(() => socket.onclose?.())
    act(() => void jest.advanceTimersByTime(4000))
    jest.useRealTimers()
    const redialled = sockets.at(-1)!
    expect(redialled).not.toBe(socket)
    await act(async () => void redialled.onopen?.())
    return redialled
  }

  // There is no cursor (ruled decision 1), so a redial can only say "a gap may have happened".
  // Re-reading the list is the entire convergence story — including for the comment that tripped
  // the 300s token expiry, which the DO drops rather than delivers.
  test('a reconnect re-reads the list', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket } = await mounted(list)

      await reconnect(socket)

      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      expect(list.mock.calls[0]![1]).toBe('index.html')
    } finally {
      list.mockRestore()
    }
  })

  // ...and it re-reads the file the iframe is on NOW. The socket outlives every in-iframe
  // navigation, so a reconnect that re-read the MOUNT file would repaint another file's threads
  // over the one on screen — the gap it was closing left wider than it found it.
  test('a reconnect after an in-iframe navigation re-reads the CURRENT file', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue([mkThread({ id: 'p2a', filePath: 'page2.html' })])
    try {
      const { socket, send } = await mounted(list)
      act(() => send({ type: 'glance:ready', filePath: 'page2.html' }))
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1)) // the navigation's own read

      await reconnect(socket)

      await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
      expect(list.mock.calls[1]![1]).toBe('page2.html')
    } finally {
      list.mockRestore()
    }
  })

  // Requirement 4, both halves. The write is pushed back to every socket in the room — the author's
  // own included — so while the socket is connected the refetch is pure duplication. With no
  // socket, that same refetch is the ONLY way the author ever sees their own comment.
  async function writeAPageComment(container: HTMLElement) {
    fireEvent.click(await screen.findByRole('button', { name: 'Add comment' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a comment of my own' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    })
    return container
  }

  test('while the stream is CONNECTED, the local user’s own create does not refetch the list', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const create = spyOn(comments, 'create').mockResolvedValue(mkThread({ id: 'mine', anchorType: 'page', quote: null }))
    const mentionable = spyOn(comments, 'mentionable').mockResolvedValue([])
    try {
      const { container, socket } = await mounted(list) // socket opened
      await writeAPageComment(container)

      expect(create).toHaveBeenCalledTimes(1)
      expect(list).not.toHaveBeenCalled()
      // Dropping the read is only safe because the room fans the write back to its AUTHOR too
      // (selectCommentRecipients excludes no one) — nothing is written optimistically, so this push
      // is the whole of how the author sees their own comment. A server that ever skipped the
      // sender would make it invisible until reload, and this is the assertion that would say so.
      await pushFrame(socket, {
        type: 'thread.created',
        siteId: 's1',
        filePath: 'index.html',
        thread: mkThread({ id: 'mine', anchorType: 'page', quote: null }),
      })
      await waitFor(() => expect(document.getElementById('thread-mine')).not.toBeNull())
    } finally {
      list.mockRestore()
      create.mockRestore()
      mentionable.mockRestore()
    }
  })

  test('while the stream is NOT connected, the same create still refetches', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const create = spyOn(comments, 'create').mockResolvedValue(mkThread({ id: 'mine', anchorType: 'page', quote: null }))
    const mentionable = spyOn(comments, 'mentionable').mockResolvedValue([])
    try {
      const { container } = renderViewer('/sp/site?review=1')
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const { iframe, send } = armIframe(container)
      loadIframe(iframe)
      act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
      await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())
      await dialledSocket() // dialled, never opened — the redial gap, or realtime simply unavailable

      await writeAPageComment(container)

      expect(create).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      expect(list.mock.calls[0]![1]).toBe('index.html')
    } finally {
      list.mockRestore()
      create.mockRestore()
      mentionable.mockRestore()
    }
  })

  // The rail's OTHER write, and the second call site requirement 4 names. A reply is pushed exactly
  // like a create (comment.created, voice included), so the same rule applies to it — but the
  // callback it arrives on is shared with resolve/delete, which are not. Hence the per-change flag.
  // Scoped to t1's own card: every OTHER thread's card has a 'Reply' button too, and once this
  // composer is open its submit button carries the same name as the one that opened it.
  async function writeAReply() {
    const card = within(document.getElementById('thread-t1') as HTMLElement)
    fireEvent.click(card.getByRole('button', { name: 'Reply' }))
    fireEvent.change(await card.findByPlaceholderText('Reply…'), { target: { value: 'a reply of my own' } })
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: 'Reply' }))
    })
  }

  test('while the stream is CONNECTED, the local user’s own reply does not refetch either', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const reply = spyOn(comments, 'reply').mockResolvedValue(mkComment('c-mine', 'a reply of my own'))
    const mentionable = spyOn(comments, 'mentionable').mockResolvedValue([])
    try {
      const { socket } = await mounted(list) // socket opened
      await writeAReply()

      expect(reply).toHaveBeenCalledTimes(1)
      expect(list).not.toHaveBeenCalled()
      // ...because the push is what shows it, same as a create.
      await pushFrame(socket, {
        type: 'comment.created',
        siteId: 's1',
        filePath: 'index.html',
        threadId: 't1',
        comment: mkComment('c-mine', 'a reply of my own'),
      })
      await waitFor(() => expect(screen.queryByText('a reply of my own')).not.toBeNull())
    } finally {
      list.mockRestore()
      reply.mockRestore()
      mentionable.mockRestore()
    }
  })

  test('while the stream is NOT connected, the same reply still refetches', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const reply = spyOn(comments, 'reply').mockResolvedValue(mkComment('c-mine', 'a reply of my own'))
    const mentionable = spyOn(comments, 'mentionable').mockResolvedValue([])
    try {
      const { container } = renderViewer('/sp/site?review=1')
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const { iframe, send } = armIframe(container)
      loadIframe(iframe)
      act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
      await waitFor(() => expect(document.getElementById('thread-t1')).not.toBeNull())
      await dialledSocket() // dialled, never opened

      await writeAReply()

      expect(reply).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      expect(list.mock.calls[0]![1]).toBe('index.html')
    } finally {
      list.mockRestore()
      reply.mockRestore()
      mentionable.mockRestore()
    }
  })

  // Ruled decision 5: resolve and delete are NOT pushed, so their refetch is the only thing that
  // updates the rail — it must survive a connected socket.
  test('resolve still refetches while the stream is connected (it is not pushed by design)', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    const setStatus = spyOn(comments, 'setStatus').mockResolvedValue(mkThread({ id: 't1', status: 'resolved' }))
    try {
      await mounted(list) // socket opened
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: /Resolve/ })[0]!)
      })

      expect(setStatus).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    } finally {
      list.mockRestore()
      setStatus.mockRestore()
    }
  })

  test('unmount disposes the stream — the socket is closed and nothing redials', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { unmount, socket } = await mounted(list)

      unmount()
      expect(socket.closed).toBe(true)

      // A close landing on a disposed stream must not schedule a dial, and a timer that somehow
      // survived must not fire one either.
      jest.useFakeTimers()
      act(() => socket.onclose?.())
      act(() => void jest.advanceTimersByTime(10000))
      jest.useRealTimers()
      expect(sockets).toHaveLength(1)
    } finally {
      list.mockRestore()
    }
  })

  // The other half of "disposed on unmount": site-to-site navigation, which the recents sidebar
  // makes a real click rather than a hypothetical. React Router keeps ONE component instance across
  // param changes, so something has to force the teardown — and THREE things independently do:
  // `<Viewer key={space/site}>`, `siteRef`'s memo, and `refresh`'s transitive dependency on it. No
  // single-line mutation can break this (each masks the others; dropping the key alone, or freezing
  // the memo alone, leaves every test here green) — it takes the key AND the memo together, which
  // is exactly what this test fails on. It is pinning the redundancy, not any one mechanism: a
  // refactor that tidies two of the three away leaks the old site's socket and feeds this rail
  // another site's comments.
  test('navigating to ANOTHER site disposes the old socket and dials the new one', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket, router } = await mounted(list)

      await act(async () => void (await router.navigate('/sp/other?review=1')))

      expect(socket.closed).toBe(true)
      const redialled = await waitFor(() => {
        const s = sockets.at(-1)!
        if (s === socket) throw new Error('no socket dialled for the new site')
        return s
      })
      expect(redialled.url).toBe(`${window.location.origin.replace(/^http/, 'ws')}/api/sites/sp/other/comments/socket`)
    } finally {
      list.mockRestore()
    }
  })

  // S12 / C22 — a typing ping rides the SAME socket as the comment events above, but it is not a
  // list change: it names a viewer and a thread, and the rail counts its expiry down locally.
  // THREADS' cards carry no comments, so u9 is an id this rail cannot put a name to — and the name
  // the payload offers must never be how it gets one, or "Riya is replying…" becomes claimable by
  // anyone with a socket.
  test('a typing ping renders on its thread — and a name in the PAYLOAD is never used', async () => {
    const cardText = (id: string) => document.getElementById(`thread-${id}`)?.textContent ?? `no card ${id}`
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket } = await mounted(list)

      await pushFrame(socket, {
        type: 'typing',
        viewerId: 'u9',
        threadId: 't1',
        expiresAt: Date.now() + 20_000,
        viewerName: 'Riya',
      })

      // Asserted straight after the act(), not through waitFor: the frame renders synchronously, and
      // a waitFor that times out red dumps the whole rendered tree into the failure.
      expect(cardText('t1')).toContain('Someone is replying…')
      expect(cardText('t1')).not.toContain('Riya')
      expect(cardText('t2')).not.toContain('replying')
      expect(list).not.toHaveBeenCalled() // a ping says nothing about the list, so nothing re-reads it
    } finally {
      list.mockRestore()
    }
  })

  // One viewer is in ONE place at a time, so their newer ping replaces the older one rather than
  // adding to it. Without that, moving between threads leaves "…is replying" behind on every thread
  // that viewer ever touched, all of them true-looking and none of them current.
  test('a viewer’s newer ping REPLACES their older one — an indicator never piles up', async () => {
    const cardText = (id: string) => document.getElementById(`thread-${id}`)?.textContent ?? `no card ${id}`
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket } = await mounted(list)
      const ping = (threadId: string, expiresAt: number) =>
        pushFrame(socket, { type: 'typing', viewerId: 'u9', threadId, expiresAt })

      await ping('t1', Date.now() + 20_000)
      await ping('t2', Date.now() + 20_000) // same viewer, moved to the other thread

      expect(cardText('t2')).toContain('is replying…')
      expect(cardText('t1')).not.toContain('replying')

      // …and a stop (the server says "over" as an already-elapsed expiry) clears the last one.
      await ping('t2', 0)
      expect(cardText('t2')).not.toContain('replying')
    } finally {
      list.mockRestore()
    }
  })

  // The send half, end to end: keystroke -> Composer.onTyping -> ReviewRail -> viewer -> the socket.
  // Every piece of this existed and was unit-tested while NOTHING connected them — the composer's
  // props were optional and no caller passed them, so the whole feature was unreachable and green.
  test('typing a reply puts a typing frame on the socket, and blurring the composer takes it back', async () => {
    const list = spyOn(comments, 'list').mockResolvedValue(THREADS)
    try {
      const { socket } = await mounted(list)
      const card = within(document.getElementById('thread-t1') as HTMLElement)

      fireEvent.click(card.getByRole('button', { name: 'Reply' }))
      const box = card.getByRole('textbox')
      fireEvent.change(box, { target: { value: 'typing a reply…' } })

      expect(socket.sent).toEqual([JSON.stringify({ type: 'typing', threadId: 't1' })])

      fireEvent.blur(box)
      expect(socket.sent).toEqual([
        JSON.stringify({ type: 'typing', threadId: 't1' }),
        JSON.stringify({ type: 'typing.stop', threadId: 't1' }),
      ])
    } finally {
      list.mockRestore()
    }
  })
})
