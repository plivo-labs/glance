import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { isAudioFile } from '@/lib/audio'
import { attachDbBroker } from '@/lib/dbBroker'
import { buildBadges, initialBadges, stepBadges } from '@/lib/badges'
import { comments, paintAnchors, type PendingAnchor, pendingToInput, type Thread } from '@/lib/comments'
import { initialPopover, stepPopover } from '@/lib/commentPopover'
import { type HighlightEvent, initialHighlight, stepHighlight } from '@/lib/highlightTarget'
import { type Intent, parseIntent } from '@/lib/parseIntent'
import { encodePathSegments } from '@/lib/paths'
import { type ArbiterEvent, type ArbiterState, type Decision, initialArbiter, stepArbiter } from '@/lib/prefetchArbiter'
import { recordVisit } from '@/lib/recents'
import type { Me } from '@/lib/types'
import { badgeOpenTarget, deepLinkReady, frameViewport, highlightCommand, railFromSearch, type RevealRequest } from '@/lib/viewerCommands'
import { loadViewer, PREFETCH_FAILED, type PrefetchResult, type ViewerLoaderData } from '@/lib/viewerLoader'
import { AudioView } from '@/components/AudioView'
import { Spinner } from '@/components/states'
import { CommandPalette } from '@/components/CommandPalette'
import { ViewerTopBar } from '@/components/ViewerTopBar'
import { BadgeOverlay } from '@/components/review/BadgeOverlay'
import { CommentPopover } from '@/components/review/CommentPopover'
import { ReviewRail } from '@/components/review/ReviewRail'
import { ViewerSidebar } from '@/components/ViewerSidebar'

// S11: the loader resolves on SITE META alone; the comments prefetch for the predicted entry file
// is fired unawaited and rides along as a pending promise — the iframe never waits on comments.
// All the logic (401 redirect, no-prefetch-on-meta-failure, null-entry root) lives in
// lib/viewerLoader where it's unit-tested.
export async function loader({ params, request }: LoaderFunctionArgs) {
  return loadViewer({ space: params.space ?? '', site: params.site ?? '', sitePath: params['*'] ?? '', request })
}

// The recents sidebar lets a user jump straight from one open site to another via a plain
// react-router <Link> (no full reload) — the FIRST in-app case of navigating between two mounts of
// this same route. React Router keeps one component instance across param changes on a matched
// route, so without a remount all the per-site useState (threads, filePath, loaded, railOpen, …)
// would leak from the old site into the new one. `key`-ing on space/site forces a clean remount on
// cross-site navigation while leaving same-site file navigation (the splat changing) alone — that
// case already reacts via the `src` memo below.
export function Component() {
  const params = useParams()
  return <Viewer key={`${params.space}/${params.site}`} />
}

function Viewer() {
  const { site, entryPath, commentsPromise } = useLoaderData() as ViewerLoaderData

  // Optional in-site file path from the route splat (`/space/site/docs/page.html`). Appended to the
  // content URL so a deep link / the directory-listing fallback opens that specific file; '' = root.
  const sitePath = useParams()['*'] ?? ''

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  // Latest file path reported by the iframe's 'ready' intent, stashed unconditionally so the
  // me-resolution effect below can flush it even when 'ready' beats the /api/auth/me fetch on a
  // fresh load (see the recordVisit gate in the intent handler). NOT arbiter.current.readyPath:
  // that resets to null on navReset, and this deliberately survives it so the OLD file's genuine
  // visit still flushes when Me resolves after a splat nav.
  const lastReadyPathRef = useRef<string | null>(null)
  const contentOrigin = useMemo(() => new URL(site.contentUrl).origin, [site.contentUrl])
  const src = useMemo(() => withAnnotate(appendPath(site.contentUrl, sitePath)), [site.contentUrl, sitePath])
  // `entryPath` (loader-resolved via resolveEntryPath, mirroring the server's normalizePath) is
  // the concrete file this URL serves — at the root that's the API's indexPath (root index.html or
  // the lone-upload fallback, e.g. recording.webm), so audio detection, the player src, and comment
  // anchoring work at the root URL too. null = the site has no known root entry (never guess).
  // Audio has no HTML document to frame — it gets a native player instead of the sandboxed
  // iframe, and (unlike the iframe src) no ?glance_annotate param: that flag only triggers the
  // HTML-injection transform in content.ts, which never applies to audio.
  const isAudio = useMemo(() => entryPath !== null && isAudioFile(entryPath), [entryPath])
  const audioSrc = useMemo(() => appendPath(site.contentUrl, entryPath ?? ''), [site.contentUrl, entryPath])

  // Is the comments rail on screen — the ONE thing this boolean means (slice C1a split it out of
  // the old `review`, which also gated composing/painting; those are unconditional as of C2b,
  // decided elsewhere, not read from here anymore).
  const [railOpen, setRailOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  // The HTML iframe only learns its file path from the annotate client's 'ready' postMessage
  // (never fires for non-HTML) — `filePath` below is what the rest of the viewer (comments,
  // rail) actually reads; for audio there's no message to wait for, so it's the splat itself.
  const [resolvedFilePath, setResolvedFilePath] = useState<string | null>(null)
  const filePath = isAudio ? entryPath : resolvedFilePath
  const [threads, setThreads] = useState<Thread[]>([])
  // A TEXT selection now comments in place, not in the rail: lib/commentPopover (slice A1) owns the
  // whole chip → composer → save lifecycle and this only executes it. Held with useReducer rather
  // than the arbiter's ref, because unlike the arbiter every transition here IS the UI.
  const [popover, dispatchPopover] = useReducer(stepPopover, undefined, initialPopover)
  // The overlay's badge model (slice B2b): the latest anchorRects batch, stepped through the pure
  // reducer in lib/badges. Held separately from `threads` because a batch's epoch race is about
  // POSITIONS, not thread content — buildBadges combines the two only at render time (below).
  const [badges, setBadges] = useState(initialBadges)
  // `dirty` is a reducer INPUT, read at dispatch time from a ref: the draft stays inside the
  // Composer (Composer.onDirtyChange), and a re-render per keystroke would buy nothing.
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  // The rail composer, now only ever the page (audio) anchor — element creation is gone (slice C2a).
  const [composing, setComposing] = useState<PendingAnchor | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)

  // Paint anchors back into the iframe via the trusted parent→child channel — UNCONDITIONALLY
  // (C2b): badges are on for anyone with access whether or not the rail panel is open, since the
  // rail is just a view onto the same threads, not a gate on showing them. The text-vs-element
  // mapping (and that an existing element thread still reaches the iframe) is lib/comments'
  // paintAnchors, unit-tested there — this is only the postMessage wiring.
  const paint = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage({ type: 'glance:paint', anchors: paintAnchors(threads) }, contentOrigin)
  }, [threads, contentOrigin])

  // ── S11 comments-load arbitration ────────────────────────────────────────────────────────────
  // The loader fires a comments prefetch BEFORE the iframe mounts; this pure reducer
  // (lib/prefetchArbiter) owns every ordering rule — generations (newer loads invalidate all older
  // in-flight results), provisional HTML prefetches (held until a matching glance:ready), stale
  // readys after a splat nav. The component only executes its decisions.
  const arbiter = useRef<ArbiterState<Thread[]>>(initialArbiter(entryPath))

  const applyDecision = useCallback((decision: Decision<Thread[]>) => {
    if (decision.kind === 'apply') setThreads(decision.data)
    else if (decision.kind === 'error')
      toast.error(decision.error instanceof ApiError ? decision.error.message : 'Failed to load comments')
    // none / ignore / discard: stale or unconfirmed results die silently — never clear state,
    // never toast over a newer success. ('refetch' is handled at the ready dispatch site.)
  }, [])

  const dispatch = useCallback(
    (event: ArbiterEvent<Thread[]>) => {
      const step = stepArbiter(arbiter.current, event)
      arbiter.current = step.state
      setResolvedFilePath(step.state.readyPath)
      applyDecision(step.decision)
      return step
    },
    [applyDecision],
  )

  // Stable site ref for fetches: slugs never change within a mount (Component keys on them).
  const siteRef = useMemo(() => ({ spaceSlug: site.spaceSlug, siteSlug: site.siteSlug }), [site.spaceSlug, site.siteSlug])

  // Start a comments load through the arbiter. `prefetch` adopts the loader's in-flight promise
  // (it never rejects — failures arrive as PREFETCH_FAILED); ad-hoc loads fetch here, and only a
  // CURRENT-generation failure surfaces (the reducer ignores stale rejections).
  const loadThreads = useCallback(
    (path: string, opts?: { provisional?: boolean; prefetch?: Promise<PrefetchResult> }) => {
      const { state } = dispatch({ type: 'start', path, provisional: opts?.provisional ?? false })
      const gen = state.inFlight?.gen
      if (gen === undefined) return Promise.resolve()
      // Returned so a mutation flow can await the refresh (keeps the composer busy until the list
      // is applied) — the chain itself never rejects, every outcome settles through the arbiter.
      if (opts?.prefetch) {
        return opts.prefetch.then((r) => {
          if (r === PREFETCH_FAILED) dispatch({ type: 'settled', gen, ok: false, error: null })
          else dispatch({ type: 'settled', gen, ok: true, data: r })
        })
      }
      return comments.list(siteRef, path).then(
        (data) => void dispatch({ type: 'settled', gen, ok: true, data }),
        (error: unknown) => void dispatch({ type: 'settled', gen, ok: false, error }),
      )
    },
    [dispatch, siteRef],
  )

  // Mutation refresh (create/reply/resolve): a fresh generation, so any older in-flight list
  // result — prefetch included — can no longer clobber what this returns.
  const refresh = useCallback((fp: string) => loadThreads(fp), [loadThreads])

  // Actionable count for the toolbar badge: open threads (mirrors the rail's default "open" list).
  const openCount = useMemo(() => threads.filter((t) => t.status === 'open').length, [threads])

  // The overlay's drawable chips: combines the latest rect batch with the current threads (for
  // visibility/author/count), recomputed only when either input actually changes.
  const badgeList = useMemo(() => buildBadges(badges, threads), [badges, threads])

  // Per-site tab title: without this the shell's static <title> ("Glance — …") shows for EVERY
  // site. site.title is owner-set or deploy-derived from the entry HTML's <title>; fall back to
  // the slug. Restored on unmount so back-navigation to the dashboard keeps the shell default.
  useEffect(() => {
    const prev = document.title
    document.title = site.title ?? site.siteSlug
    return () => {
      document.title = prev
    }
  }, [site.title, site.siteSlug])

  // glance.db credential broker: the injected SDK in the iframe hands us a MessagePort; we
  // execute its data-plane requests with OUR token so no credential ever enters the untrusted
  // frame (P0-1). Bound to THIS site — the page cannot ask for another site's data.
  useEffect(() => {
    const broker = attachDbBroker({
      site: { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug },
      contentOrigin,
      getSource: () => iframeRef.current?.contentWindow,
    })
    return broker.dispose
  }, [site.spaceSlug, site.siteSlug, contentOrigin])

  // Listen for intents from the iframe. parseIntent re-validates origin+source; it is a filter,
  // not a trust oracle — nothing here writes without a subsequent explicit user action.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const intent: Intent | null = parseIntent(e, { origin: contentOrigin, source: iframeRef.current?.contentWindow ?? null })
      if (!intent) return
      if (intent.type === 'ready') {
        // Audio has no iframe/'ready'; for HTML this is where the SPA learns the current file.
        // The arbiter arbitrates: a matching ready applies the parked prefetch, a mismatch discards
        // it and orders a fresh fetch, a duplicate or a stale ready (old iframe doc after a splat
        // nav) is ignored outright — including for recordVisit below.
        const { state, decision } = dispatch({ type: 'ready', path: intent.filePath })
        if (decision.kind === 'refetch') loadThreads(decision.path)
        // 'ignore' covers duplicates too — a duplicate ready no longer double-counts a visit.
        if (decision.kind === 'ignore') return
        if (state.readyPath !== intent.filePath) return
        lastReadyPathRef.current = intent.filePath
        // Every in-iframe navigation fires 'ready' with the real current file — the only place the
        // SPA learns it, since the URL doesn't change on in-page navigation. Skip until Me resolves
        // (never record to an unknown/shared-machine user); the me-effect below flushes the ref once
        // Me resolves, so a 'ready' that beats the /api/auth/me fetch on a fresh load isn't dropped.
        if (me) recordVisit(me.id, { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug, title: site.title, filePath: intent.filePath })
      }
      // UNCONDITIONAL (C2b): commenting is on for anyone with access, not just while the rail is
      // open — a text selection feeds the popover reducer (chip first, composer only on an
      // explicit click) whether or not the rail panel happens to be visible.
      else if (intent.type === 'select')
        dispatchPopover({
          type: 'select',
          // A rect is what the chip is pinned to. parseIntent leaves it optional (our own annotate
          // client always sends one), so a message without one still gets a chip — at the frame's
          // top-left, clickable — rather than silently losing the selection.
          anchor: { quote: intent.quote, context: intent.context, rect: intent.rect ?? { top: 0, left: 0, width: 0, height: 0 } },
          dirty: dirtyRef.current,
        })
      else if (intent.type === 'clear') dispatchPopover({ type: 'clear' })
      // Neither of these is observable from the parent: they happen inside a cross-origin document.
      else if (intent.type === 'clickAway') dispatchPopover({ type: 'clickAway', dirty: dirtyRef.current })
      else if (intent.type === 'escape') dispatchPopover({ type: 'dismiss' })
      // The iframe's own box IS the frame viewport (the overlay is mounted as its sibling in that
      // same wrapper) — measuring it HERE, in the event handler, is what keeps lib/badges pure and
      // avoids a ResizeObserver just to learn a size the DOM already hands us for free. Badges are
      // unconditional too (C2b) — no railOpen gate.
      else if (intent.type === 'anchorRects') {
        setBadges((s) => stepBadges(s, intent, frameViewport(iframeRef.current)))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [contentOrigin, me, site.spaceSlug, site.siteSlug, site.title, dispatch, loadThreads])

  useEffect(() => {
    api
      .get<Me>('/api/auth/me')
      .then((m) => {
        setMe(m)
        // Site-level visit (filePath '') — recorded once Me is known, independent of any in-iframe
        // navigation (which may never report a file, e.g. a single-page site with no postMessage).
        recordVisit(m.id, { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug, title: site.title, filePath: '' })
        // Flush whatever file the iframe already reported ready for — on a fresh load 'ready' usually
        // beats this fetch, and the intent handler's `if (me)` gate above would otherwise drop it.
        if (lastReadyPathRef.current) {
          recordVisit(m.id, { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug, title: site.title, filePath: lastReadyPathRef.current })
        }
      })
      .catch(() => setMe(null))
  }, [site.spaceSlug, site.siteSlug, site.title])

  // Consume the loader's prefetch + reset on splat navigation (viewer → another file in the SAME
  // site; cross-site nav remounts via the Component key). A nav brings the loading overlay back and
  // clears per-file state, and the arbiter reset makes any in-flight result or late ready from the
  // OLD file inert. Each loader run yields a fresh commentsPromise — consumed exactly once (by
  // identity), so revalidations can't double-start a load. Threads then reach state only through
  // arbiter decisions: prefetch apply (HTML on matching ready, audio on settle), ready-driven
  // refetch, or mutation refresh — powering the toolbar badge before review opens and seeding the
  // rail, which stays fresh via onCreate/onChanged.
  const prevSitePath = useRef(sitePath)
  const consumedPrefetch = useRef<Promise<PrefetchResult> | null>(null)
  useEffect(() => {
    if (prevSitePath.current !== sitePath) {
      prevSitePath.current = sitePath
      dispatch({ type: 'navReset', expected: entryPath })
      setThreads([])
      setComposing(null)
      dispatchPopover({ type: 'dismiss' }) // a chip/popover pinned to the OLD document's rect
      setBadges(initialBadges()) // badges pinned to the OLD document's rects too
      dispatchHighlight({ type: 'navigate' }) // a highlight lit in the OLD document too
      setLoaded(false)
    }
    if (commentsPromise && commentsPromise !== consumedPrefetch.current && entryPath !== null) {
      consumedPrefetch.current = commentsPromise
      // HTML stays provisional until its glance:ready confirms the path; audio has no iframe (and
      // thus no ready) — it applies as soon as it settles, keeping the audio player's rail working.
      loadThreads(entryPath, { provisional: !isAudio, prefetch: commentsPromise })
    }
  }, [sitePath, entryPath, commentsPromise, isAudio, dispatch, loadThreads])

  useEffect(paint, [paint])

  // Audio view: no DOM to select text/elements in, so the rail's "Add comment" button starts a
  // bare page-anchored composer directly (no selection step).
  const startPageComment = useCallback(() => setComposing({ kind: 'page' }), [])

  // Read on demand (an event handler, not a subscription) — never causes a re-render, so the
  // timestamp button always inserts whatever the player's position is AT CLICK TIME with no
  // state/effect plumbing.
  const getCurrentTime = useCallback(() => audioRef.current?.currentTime ?? 0, [])

  // ⌘K / Ctrl-K opens the command palette here too, mirroring the AppShell dashboard chrome.
  // (Keydown only reaches the parent when focus is outside the sandboxed iframe; the header
  // Search button is the always-available fallback.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // B3b-hard: which thread ids are lit RIGHT NOW is a pure decision (lib/highlightTarget),
  // extracted for the same reason lib/badges and lib/commentPopover were — so hover-replaces-not-
  // unions, and every clear (leave/exitReview/navigate), are unit-tested instead of living inline
  // in callbacks. This component only dispatches events and posts whatever the reducer says.
  const [highlightState, dispatchHighlight] = useReducer(stepHighlight, undefined, initialHighlight)

  // Post the current highlight to the iframe whenever the reducer's output actually changes —
  // `stepHighlight` returns the SAME state object for a no-op event, so an unrelated re-render
  // never re-sends it. Guarded by `loaded` like the other parent→child posts below (the client's
  // message listener isn't wired until then).
  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !loaded) return
    win.postMessage(highlightCommand(highlightState), contentOrigin)
  }, [highlightState, loaded, contentOrigin])

  // Shared entry point for every "hover" source (badge pointer/focus, rail-card pointer/focus):
  // a null or empty id list is a leave, otherwise the ids REPLACE whatever was lit before — never
  // a union across two hovered chips.
  const hoverHighlight = useCallback((ids: string[] | null) => {
    const event: HighlightEvent = ids && ids.length > 0 ? { type: 'hover', ids } : { type: 'leave' }
    dispatchHighlight(event)
  }, [])

  // Scroll an anchor into view in the iframe: element → its selector; text → its quote. Deliberately
  // the ONLY thing a rail-card/badge CLICK does — B3b-hard's fix is that lighting the highlight is
  // never a side effect of scrolling: it comes exclusively from hoverHighlight (pointer/focus) and
  // must clear on leave/blur, which a click has no matching event for.
  const scrollAnchor = useCallback(
    (thread: Thread) => {
      const win = iframeRef.current?.contentWindow
      if (!win) return
      if (thread.anchorType === 'element' && thread.anchor)
        win.postMessage({ type: 'glance:focus', selector: thread.anchor.selector }, contentOrigin)
      // Context rides along so focusing lands on the SAME occurrence the paint highlighted.
      else if (thread.quote) win.postMessage({ type: 'glance:focus', quote: thread.quote, context: thread.context }, contentOrigin)
    },
    [contentOrigin],
  )

  // Deep-link contract (a notification click lands here): `?review=1` opens the rail forever — it's
  // baked into ALREADY-SENT Slack messages and notification-bell links, so it's a permanent alias
  // (railFromSearch), not a migration — and `?thread=<id>` focuses that thread — scroll the iframe
  // to its anchor + its rail card into view, once the frame is loaded and that file's threads are
  // in. `filePath` in the notification's URL path ensures the right file (and thus the thread) is
  // what loads. Fires at most once.
  const [searchParams] = useSearchParams()
  const wantRailOpen = railFromSearch(searchParams)
  const deepLinkThreadId = searchParams.get('thread')
  const deepLinkFocused = useRef(false)

  useEffect(() => {
    if (wantRailOpen) setRailOpen(true)
  }, [wantRailOpen])

  useEffect(() => {
    const target = threads.find((t) => t.id === deepLinkThreadId)
    // Readiness differs by content kind (slice C1b, lib/viewerCommands' deepLinkReady): an HTML
    // page waits on the iframe's `loaded` onLoad; audio renders no iframe, so `loaded` never fires
    // and gating on it left `?thread=` on an audio page permanently dead — audio is ready as soon
    // as its thread has arrived.
    if (deepLinkFocused.current || !deepLinkThreadId || !railOpen || !deepLinkReady({ isAudio, loaded, hasThread: !!target })) return
    deepLinkFocused.current = true
    // Scroll the iframe to the anchor; the rail reveals + scrolls the thread card itself (ReviewRail
    // owns the open/resolved filter, so it can un-hide a resolved target). scrollAnchor only —
    // landing here is a page load, not a click or hover, so `navigate` is dispatched too (a
    // deep-link mount lights NOTHING; see lib/highlightTarget's 'navigate' case).
    scrollAnchor(target!)
    dispatchHighlight({ type: 'navigate' })
  }, [deepLinkThreadId, railOpen, loaded, isAudio, threads, scrollAnchor])

  // Stable identity for ReviewRail's focusRequest prop: an inline object literal here would be a
  // NEW reference on every viewer render (threads loading, `loaded` flipping, badge batches
  // arriving, …), and ReviewRail's reveal effect is keyed on `[focusRequest, threads]` — so every
  // unrelated re-render would re-run it, whose cleanup cancels the pending rAF card-scroll before
  // it fires, and the re-run then no-ops on the (nonce-)unchanged request. Memoized on the one
  // thing that should actually change it: the deep link's own id (nonce is a constant 0 here — see
  // the comment on ReviewRail's focusRequest prop below).
  const deepLinkFocusRequest = useMemo(
    () => (deepLinkThreadId ? { id: deepLinkThreadId, nonce: 0 } : null),
    [deepLinkThreadId],
  )

  // The rail's reveal has two producers: the one-shot deep link above and badge clicks. A badge is
  // the source the nonce was built for — the same thread can be clicked over and over, and each
  // click must reveal again, so the counter (not the thread id) is what changes. Once a click has
  // happened it wins for the rest of the page's life; the deep link fires at most once, at mount,
  // before any click can have landed.
  const [badgeFocusRequest, setBadgeFocusRequest] = useState<RevealRequest | null>(null)
  const badgeRevealNonce = useRef(0)
  const revealFromBadge = useCallback((thread: Thread) => {
    setRailOpen(true)
    badgeRevealNonce.current += 1
    setBadgeFocusRequest({ id: thread.id, nonce: badgeRevealNonce.current })
  }, [])

  // The one create path, text and voice alike, rail and popover alike — hence the anchor is an
  // ARGUMENT: the rail's page/element anchor and the popover's text anchor drive the same write.
  // It REJECTS on every failure — no anchor yet, or the write itself failing. The composer treats a
  // resolved onSubmit as success and clears the draft, so anything that resolves without having
  // written destroys what the user typed (or recorded). Toast for the human, rethrow for the
  // composer. `onWritten` closes whichever composer started it, before the list refresh it awaits.
  // `filePath` is null until the iframe reports ready.
  async function submitThread(
    failMsg: string,
    anchor: PendingAnchor | null,
    write: (path: string, anchor: PendingAnchor) => Promise<unknown>,
    onWritten: () => void,
  ) {
    if (!filePath || !anchor) {
      toast.error('This page is still loading — try again in a moment')
      throw new Error('no anchor to comment on yet')
    }
    try {
      await write(filePath, anchor)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : failMsg)
      throw err
    }
    onWritten()
    await refresh(filePath)
  }

  const createThread = (body: string, mentions: string[]) =>
    submitThread('Failed to add comment', composing, (path, anchor) => comments.create(site, pendingToInput(path, body, anchor), mentions), () =>
      setComposing(null),
    )

  // Voice sibling: the anchor fields come from the same pending anchor (body is the server-side
  // transcript, so it's dropped from the multipart payload).
  const createVoiceThread = (blob: Blob) =>
    submitThread(
      'Failed to add voice comment',
      composing,
      (path, anchor) => {
        const { body: _body, ...fields } = pendingToInput(path, '', anchor)
        return comments.createVoice(site, blob, fields)
      },
      () => setComposing(null),
    )

  // The popover's half of the same path: its anchor is the open composer's text anchor, and the
  // reducer — not this — decides what a settle closes, so both outcomes are reported to it.
  async function popoverWrite(run: (anchor: PendingAnchor, onWritten: () => void) => Promise<void>) {
    const open = popover.composer
    if (!open) return
    dispatchPopover({ type: 'submit' })
    try {
      await run({ kind: 'text', quote: open.anchor.quote, context: open.anchor.context }, () =>
        dispatchPopover({ type: 'saveSettled', id: open.id, ok: true }),
      )
    } catch (err) {
      dispatchPopover({ type: 'saveSettled', id: open.id, ok: false })
      throw err // a failed write keeps the popover open on its draft — see submitThread
    }
  }

  const createPopoverThread = (body: string, mentions: string[]) =>
    popoverWrite((anchor, onWritten) =>
      submitThread('Failed to add comment', anchor, (path, a) => comments.create(site, pendingToInput(path, body, a), mentions), onWritten),
    )

  const createPopoverVoiceThread = (blob: Blob) =>
    popoverWrite((anchor, onWritten) =>
      submitThread(
        'Failed to add voice comment',
        anchor,
        (path, a) => {
          const { body: _body, ...fields } = pendingToInput(path, '', a)
          return comments.createVoice(site, blob, fields)
        },
        onWritten,
      ),
    )

  // Closes the rail panel — via the Comments toggle or the rail's own ✕ (C2b: "Done" and the old
  // review-mode exit are gone, but closing still clears what only makes sense while the panel is
  // open: the rail's own page-anchor composer, and whatever's lit from a rail-card hover). It does
  // NOT touch the popover (dispatchPopover) — that used to be safe because the popover was ALSO
  // gated on review and unmounted the moment review ended; now it's unconditional (C2b), so
  // dismissing it here would destroy an unrelated in-progress draft just because the user closed
  // the rail panel. The popover has its own explicit teardown (Escape / click-away / save).
  function closeRail() {
    setRailOpen(false)
    setComposing(null)
    dispatchHighlight({ type: 'exitReview' })
  }

  const toggleRail = () => (railOpen ? closeRail() : setRailOpen(true))

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <ViewerTopBar
        site={site}
        sitePath={sitePath}
        railOpen={railOpen}
        commentCount={openCount}
        onToggleRail={toggleRail}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onSearch={() => setCmdOpen(true)}
      />

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} user={me} />

      <ViewerSidebar
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        userId={me?.id ?? null}
        currentSpaceSlug={site.spaceSlug}
        currentSiteSlug={site.siteSlug}
      />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* The loading overlay lives inside this wrapper so its coords match the iframe viewport. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 justify-center bg-muted/20">
          <div className="relative h-full w-full">
            {isAudio ? (
              <AudioView src={audioSrc} fileName={(entryPath ?? '').split('/').pop() ?? ''} audioRef={audioRef} />
            ) : (
              <iframe
                ref={iframeRef}
                // Hosted HTML is rendered on a stable WHITE canvas (the browser's default page
                // background that every uploaded document assumes), NOT the theme-aware
                // `bg-background` — which is dark in dark mode, so a doc with hardcoded dark text
                // and no background of its own showed dark-on-dark (invisible). A doc that designs
                // itself dark still paints over this white with its own background. colorScheme:light
                // keeps native controls/scrollbars consistent with the light canvas.
                className="size-full border-0 bg-white"
                style={{ colorScheme: 'light' }}
                src={src}
                title={site.title ?? site.siteSlug}
                onLoad={() => setLoaded(true)}
                // allow-top-navigation-by-user-activation: lets the directory-listing links (target=_top)
                // break out to the app route on a user click, so the address bar updates. Gesture-gated,
                // so iframed content can't silently redirect the tab.
                // allow-popups + allow-popups-to-escape-sandbox: the content worker rewrites external
                // links (other origins) to target=_blank; these two flags let that click open a REAL
                // new tab that isn't itself sandboxed, so the destination site loads normally.
                sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-top-navigation-by-user-activation"
              />
            )}
            {/* Sibling of the iframe ON PURPOSE: this wrapper is the iframe's own box, so the rect
                the frame reports needs no translation to position the chip/popover over it.
                UNCONDITIONAL on railOpen (C2b): anyone who can open the site can comment — the rail
                is just a panel, not a gate on the popover or the badges below. */}
            {!isAudio && (
              <CommentPopover
                chip={popover.chip}
                composer={popover.composer}
                onActivate={() => dispatchPopover({ type: 'activate' })}
                onDismiss={() => dispatchPopover({ type: 'dismiss' })}
                onSubmit={createPopoverThread}
                onSubmitVoice={createPopoverVoiceThread}
                loadMentions={() => comments.mentionable(site)}
                onDirtyChange={onDirtyChange}
              />
            )}
            {!isAudio && (
              <BadgeOverlay
                badges={badgeList}
                // A badge click scrolls the iframe to the anchor AND reveals the thread in the rail
                // — opening the rail if it was closed, and (in ReviewRail) moving the status tab to
                // the target's own, so the reveal can't be swallowed by whichever filter the user
                // left selected. With the rail closed a badge is the only comment affordance on
                // screen, so scrolling alone would point at a thread nothing can show.
                onOpen={(threadIds) => {
                  const target = badgeOpenTarget(threadIds, threads)
                  if (!target) return
                  scrollAnchor(target)
                  revealFromBadge(target)
                }}
                onHoverChange={hoverHighlight}
              />
            )}
            {!isAudio && !loaded && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
                <Spinner className="size-6" />
                <span className="text-sm">Loading preview…</span>
              </div>
            )}
          </div>
        </div>

        {railOpen && (
          <ReviewRail
            site={site}
            me={me}
            threads={threads}
            composing={composing}
            onCancelComposer={() => setComposing(null)}
            onCreate={createThread}
            onCreateVoice={createVoiceThread}
            onChanged={() => filePath && refresh(filePath)}
            onFocusAnchor={scrollAnchor}
            onHoverThread={hoverHighlight}
            onClose={closeRail}
            onStartComment={isAudio ? startPageComment : undefined}
            getCurrentTime={isAudio ? getCurrentTime : undefined}
            // Badge clicks take over from the deep link once one has happened (see revealFromBadge):
            // the link is one-shot at mount and carries a constant nonce, while a badge re-requests
            // the same thread on every click and bumps the nonce to say so. Both are stable
            // references — an inline literal here re-ran ReviewRail's reveal effect on every viewer
            // render and silently dropped the pending card scroll.
            focusRequest={badgeFocusRequest ?? deepLinkFocusRequest}
          />
        )}
      </div>
    </div>
  )
}

function withAnnotate(u: string): string {
  const url = new URL(u)
  url.searchParams.set('glance_annotate', '1')
  return url.toString()
}

// contentUrl always ends in `/` (…/space/site/ or …/_t/token/space/site/); append the in-site
// path so sub-resources still resolve relative to the site root. Each segment is encoded.
function appendPath(contentUrl: string, filePath: string): string {
  if (!filePath) return contentUrl
  return contentUrl + encodePathSegments(filePath)
}
