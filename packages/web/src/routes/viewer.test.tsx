// B2c "viewer wiring" — the two behaviors the slice spec calls out by name that no test anywhere
// else touches (viewer.tsx is otherwise an intentionally-untested wiring shell; see badges.ts,
// prefetchArbiter.ts etc. for where the actual logic lives and is unit-tested):
//
//   1. the anchorRects handler measures the IFRAME'S OWN clientWidth/clientHeight at the moment a
//      batch arrives (not a hardcoded/default box) — that's what keeps lib/badges pure.
//   2. badge state resets to initialBadges() on splat navigation, so a chip pinned to the OLD
//      document's rect doesn't survive a same-site file change.
//
// Every OTHER child (chrome, sidebar, command palette, rail) is stubbed to `null`: this test is
// scoped to the badge wiring, not a full-viewer render — those pieces have (or don't need) their
// own coverage. CommentPopover is deliberately NOT stubbed here (see note below the import).
import { describe, expect, mock, test } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, type LoaderFunctionArgs, RouterProvider } from 'react-router'
import type { Thread } from '@/lib/comments'
import type { ViewerLoaderData } from '@/lib/viewerLoader'
import type { ViewerSite } from '@/lib/types'

// bun's mock.module swaps a specifier's resolution for the WHOLE process, and it's the module
// GRAPH LINKING (which runs across every test file before any test body executes) that reads it —
// not just this file's own test run — so an `afterAll` restore here is too late to save another
// file's static `import` of the same specifier. CommentPopover has its own dedicated unit test
// (CommentPopover.test.tsx) that imports the real component directly; mocking it here to `null`
// silently broke every one of those tests process-wide. It's left real and unmocked instead — safe
// because every test in this file leaves its chip/composer state null (no 'select' intent is ever
// sent), so the real component renders nothing observable.
mock.module('@/components/ViewerTopBar', () => ({ ViewerTopBar: () => null }))
mock.module('@/components/ViewerSidebar', () => ({ ViewerSidebar: () => null }))
mock.module('@/components/CommandPalette', () => ({ CommandPalette: () => null }))
mock.module('@/components/review/ReviewRail', () => ({ ReviewRail: () => null }))

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

describe('viewer wiring — badge overlay', () => {
  test('anchorRects filters offscreen rects against the IFRAME\'S OWN measured box, not a default', async () => {
    const { container } = renderViewer('/sp/site?review=1')
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const { send } = armIframe(container)

    // Confirm the provisional HTML prefetch against the iframe's real path so `threads` populates —
    // otherwise every rect below is dropped for "no matching thread" before offscreen even runs.
    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    await waitFor(() => expect(screen.queryAllByRole('button')).toHaveLength(0)) // no rects yet, but ready applied

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
      const btns = screen.getAllByRole('button')
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
    const { send } = armIframe(container)

    act(() => send({ type: 'glance:ready', filePath: 'index.html' }))
    // Several reflow frames on the OLD document, ending well above epoch 0.
    act(() => send({ type: 'glance:anchor-rects', epoch: 5, rects: [{ id: 't1', rect: { top: 10, left: 10, width: 5, height: 5 } }] }))
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))

    // Same site, different splat — the exact nav the reset guards (a cross-site nav would instead
    // remount via the Component key, never reaching this branch).
    await act(async () => {
      await router.navigate('/sp/site/other.html?review=1')
    })
    act(() => send({ type: 'glance:ready', filePath: 'other.html' }))
    await waitFor(() => expect(screen.queryAllByRole('button')).toHaveLength(0)) // threads reset, no rects yet

    // The NEW iframe's own first reflow frame — always epoch 0.
    act(() => send({ type: 'glance:anchor-rects', epoch: 0, rects: [{ id: 't3', rect: { top: 10, left: 10, width: 5, height: 5 } }] }))

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))
  })
})
