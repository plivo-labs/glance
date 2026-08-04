import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { applyCommentEvent } from '@/lib/applyCommentEvent'
import { isAudioFile } from '@/lib/audio'
import { type CommentStream, type CommentStreamEvent, createCommentStream } from '@/lib/commentStream'
import { attachDbBroker } from '@/lib/dbBroker'
import { comments, paintAnchors, type PendingAnchor, pendingToInput, type Thread } from '@/lib/comments'
import { initialPopover, stepPopover } from '@/lib/commentPopover'
import { type Intent, parseIntent } from '@/lib/parseIntent'
import { encodePathSegments } from '@/lib/paths'
import { type ArbiterEvent, type ArbiterState, type Decision, initialArbiter, stepArbiter } from '@/lib/prefetchArbiter'
import { recordVisit } from '@/lib/recents'
import type { Me } from '@/lib/types'
import { deepLinkReady, railFromSearch, type RevealRequest } from '@/lib/viewerCommands'
import { loadViewer, PREFETCH_FAILED, type PrefetchResult, type ViewerLoaderData } from '@/lib/viewerLoader'
import { AudioView } from '@/components/AudioView'
import { Spinner } from '@/components/states'
import { CommandPalette } from '@/components/CommandPalette'
import { ViewerTopBar } from '@/components/ViewerTopBar'
import { CommentPopover } from '@/components/review/CommentPopover'
import { ReviewRail, type TypingPing } from '@/components/review/ReviewRail'
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

  // Is the comments rail on screen. It gates the on-page HIGHLIGHTS again (the rail is the panel
  // that explains them, so they live and die with it) but NOT commenting: selecting text still
  // composes in place with the panel closed.
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
  // `dirty` is a reducer INPUT, read at dispatch time from a ref: the draft stays inside the
  // Composer (Composer.onDirtyChange), and a re-render per keystroke would buy nothing.
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  // The rail composer, now only ever the page anchor — element creation is gone (slice C2a). Note
  // this is INDEPENDENT of `popover` above: neither clears the other, so both can be open at once.
  // That is why the rail offers a page comment behind a button rather than an always-open textarea
  // (#112) — an always-open one would make two live drafts the norm, not the exception.
  const [composing, setComposing] = useState<PendingAnchor | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)

  // Paint anchors back into the iframe via the trusted parent→child channel. A paint IS the
  // highlight now (client.ts lights everything it's sent), so this is gated on `railOpen`: open the
  // panel and every commented passage lights up, close it and the EMPTY paint below clears the page
  // — the reader gets the document exactly as its author wrote it. The text-vs-element mapping (and
  // that an existing element thread still reaches the iframe) is lib/comments' paintAnchors,
  // unit-tested there — this is only the postMessage wiring.
  // `loaded` is a DEPENDENCY, not just a guard: the client's message listener isn't wired until the
  // frame has booted, so a paint posted before that is dropped on the floor with nothing to re-fire
  // it — which is exactly the `?review=1` deep link (rail open and threads in before onLoad).
  const paint = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !loaded) return
    win.postMessage({ type: 'glance:paint', anchors: railOpen ? paintAnchors(threads) : [] }, contentOrigin)
  }, [threads, railOpen, loaded, contentOrigin])

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

  // ── S9 pushed comment events ─────────────────────────────────────────────────────────────────
  // The rail stops asking and starts listening: the site's comments socket pushes creates and
  // replies (Phase 1+2) and lib/applyCommentEvent folds each one into `threads`. Nothing else is
  // needed for the page to keep up — `paint` already derives from `threads`, so the chips repaint
  // for free, and `openCount` (the toolbar badge) recomputes with them.
  const streamRef = useRef<CommentStream | null>(null)
  // The socket is per SITE and outlives every in-iframe file change, so its callbacks read the
  // current file from a ref rather than closing over it: making `filePath` a dependency of the
  // effect below would re-dial on every in-page navigation and drop events for the redial's length.
  const filePathRef = useRef(filePath)
  useEffect(() => {
    filePathRef.current = filePath
  }, [filePath])

  // S12 — who is replying right now. A ping carries its own ABSOLUTE expiry and is never retracted
  // (the room schedules nothing; a closed laptop just stops sending), so the rail counts it down on
  // its own clock and nothing here has to expire anything. Keyed by VIEWER: a person types in one
  // place at a time, so a new ping replaces that viewer's previous one — and any ping already past
  // its expiry is dropped on the way in, so this can't grow with the length of the session.
  const [typing, setTyping] = useState<TypingPing[]>([])

  const onPushed = useCallback(
    // Both frames the comments channel carries — the transport declares the union (S8), so the
    // discriminant below is the only thing that tells them apart here.
    (event: CommentStreamEvent) => {
      if (event.type === 'typing') {
        // Destructured, never spread: ONLY these three fields cross into the rail, so a payload
        // that also carried a display name could not get it rendered.
        const { viewerId, threadId, expiresAt } = event
        const now = Date.now()
        setTyping((live) => {
          // Dropping this viewer's previous ping is what makes a stop (expiresAt 0) work: the ping
          // it replaces is gone, and an already-elapsed one is never added back — so the list holds
          // live pings only and cannot grow with the length of the session.
          const others = live.filter((p) => p.viewerId !== viewerId && p.expiresAt > now)
          return expiresAt > now ? [...others, { viewerId, threadId, expiresAt }] : others
        })
        return
      }
      // The fold goes THROUGH the arbiter rather than straight to setThreads: a push landing while a
      // list read is unsettled must be applied to the list that read returns (applying it now would
      // paint it onto a list the settle is about to replace — the comment would vanish). Only the
      // arbiter knows whether one is in flight, and which file it is for, so it holds the fold and
      // runs it at apply time. 'live' means nothing is unsettled: this is the on-screen list's file.
      const { decision } = dispatch({ type: 'push', apply: (list, path) => applyCommentEvent(list, event, path) })
      const fp = filePathRef.current
      if (decision.kind === 'live' && fp) setThreads((list) => decision.apply(list, fp))
    },
    [dispatch],
  )

  useEffect(() => {
    const stream = createCommentStream({
      site: siteRef,
      appOrigin: window.location.origin,
      onEvent: onPushed,
      // There is no cursor to replay from (ruled decision 1), so a redial can only mean "a gap may
      // have happened" — including the one comment the 300s token expiry drops. Re-reading the list
      // is the whole convergence story.
      onReconnect: () => {
        const fp = filePathRef.current
        if (fp) void refresh(fp)
      },
    })
    streamRef.current = stream
    return () => {
      streamRef.current = null
      stream.dispose()
    }
    // All three are stable for the life of a mount (siteRef is memoized on slugs the Component keys
    // on), so this dials ONCE per site and disposes on unmount — never mid-session.
  }, [siteRef, onPushed, refresh])

  // A local write's list refetch, dropped in exactly one case: the room fans this write back to
  // every socket on the site — the author's own included — so a PUSHED change on a CONNECTED stream
  // is already on its way and the read would only ask for what we are about to be told. Anything
  // else still reads: resolve/reopen/delete are never pushed (ruled decision 5), and with no live
  // socket (the redial gap, or realtime unavailable) the read is the only way the author ever sees
  // their own write. Returned so a mutation flow can keep its composer busy until the list lands.
  // Stable across renders so ReviewRail's own memoized children don't churn: the stream itself is
  // held in a ref precisely because it is replaced on redial, and neither of these should change
  // identity when it is.
  const sendTyping = useCallback((threadId: string) => streamRef.current?.sendTyping(threadId), [])
  const sendTypingStop = useCallback((threadId: string) => streamRef.current?.sendTypingStop(threadId), [])

  const refreshUnlessPushed = useCallback(
    (fp: string, pushed: boolean) => (pushed && streamRef.current?.connected() ? Promise.resolve() : refresh(fp)),
    [refresh],
  )

  // Actionable count for the toolbar badge: open threads (mirrors the rail's default "open" list).
  const openCount = useMemo(() => threads.filter((t) => t.status === 'open').length, [threads])

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

  // The rail's reveal has two producers: the one-shot deep link below and clicks on a painted
  // highlight. A click is the source the nonce was built for — the same thread can be clicked over
  // and over, and each click must reveal again, so the counter (not the thread id) is what changes.
  // Once a click has happened it wins for the rest of the page's life; the deep link fires at most
  // once, at mount, before any click can have landed.
  const [clickFocusRequest, setClickFocusRequest] = useState<RevealRequest | null>(null)
  const clickRevealNonce = useRef(0)
  const revealThread = useCallback((thread: Thread) => {
    setRailOpen(true)
    clickRevealNonce.current += 1
    setClickFocusRequest({ id: thread.id, nonce: clickRevealNonce.current })
  }, [])

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
      // Nor is a keystroke inside the frame — the reason ⌘K doesn't work there either. The reducer
      // is the authority on whether this opens anything (#117).
      else if (intent.type === 'commentKey') dispatchPopover({ type: 'commentKey' })
      // A click on a painted highlight — the page→rail direction. The id is looked up in OUR
      // threads (a forged one matches nothing and reveals nothing), and the rail is necessarily
      // already open, since nothing is painted while it's closed.
      else if (intent.type === 'anchorClick') {
        const target = threads.find((t) => t.id === intent.id)
        if (target) revealThread(target)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [contentOrigin, me, site.spaceSlug, site.siteSlug, site.title, threads, dispatch, loadThreads, revealThread])

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

  // The rail's "Add comment" button starts a bare page-anchored composer directly (no selection
  // step) — for every content type, not just audio (#112). Audio NEEDS it (there is no DOM to
  // select in); everywhere else it is how you say something about the page as a whole rather than
  // about one arbitrary sentence. Text selection still composes in the popover, untouched.
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

  // Scroll an anchor into view in the iframe: element → its selector; text → its quote. What a rail
  // card's click does; nothing about it changes what is LIT, because everything already is for as
  // long as the rail is open.
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
    // owns the open/resolved filter, so it can un-hide a resolved target).
    scrollAnchor(target!)
  }, [deepLinkThreadId, railOpen, loaded, isAudio, threads, scrollAnchor])

  // Stable identity for ReviewRail's focusRequest prop: an inline object literal here would be a
  // NEW reference on every viewer render (threads loading, `loaded` flipping, …), and ReviewRail's
  // reveal effect is keyed on `[focusRequest, threads]` — so every unrelated re-render would re-run
  // it, whose cleanup cancels the pending rAF card-scroll before it fires, and the re-run then
  // no-ops on the (nonce-)unchanged request. Memoized on the one thing that should actually change
  // it: the deep link's own id (nonce is a constant 0 here — see the comment on ReviewRail's
  // focusRequest prop below).
  const deepLinkFocusRequest = useMemo(
    () => (deepLinkThreadId ? { id: deepLinkThreadId, nonce: 0 } : null),
    [deepLinkThreadId],
  )

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
    // Adding a comment OPENS the rail — always. The new thread's own card appearing there is the
    // confirmation (and its highlight lighting up on the page), so there is no toast: a toast was
    // only ever standing in for a panel that wasn't allowed to open itself. Already open is a no-op.
    setRailOpen(true)
    // S9: a create IS pushed, so with a live stream this read goes away (see refreshUnlessPushed).
    await refreshUnlessPushed(filePath, true)
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

  // Closes the rail panel — via the Comments toggle or the rail's own ✕ — and clears the rail's own
  // page-anchor composer with it. The on-page highlights go too, but not from here: `railOpen` is a
  // dependency of `paint`, so flipping it re-runs that effect with an empty anchor list. It does NOT
  // touch the popover (dispatchPopover) — that used to be safe because the popover was ALSO gated on
  // review and unmounted the moment review ended; now it's unconditional (C2b), so dismissing it
  // here would destroy an unrelated in-progress draft just because the user closed the rail panel.
  // The popover has its own explicit teardown (Escape / click-away / save).
  function closeRail() {
    setRailOpen(false)
    setComposing(null)
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
        // Print rides the annotate client's command channel; audio has no document to print.
        onPrint={
          isAudio
            ? undefined
            : () => iframeRef.current?.contentWindow?.postMessage({ type: 'glance:print' }, contentOrigin)
        }
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
                // allow-modals: window.print() counts as a modal, and Chromium blocks it in a
                // sandboxed frame without this flag — required by the Print / Save as PDF action
                // (the annotate client's glance:print handler). Also un-blocks alert()/confirm()
                // for hosted pages, which matches how interactive artifacts behave elsewhere.
                sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-top-navigation-by-user-activation allow-modals"
              />
            )}
            {/* Sibling of the iframe ON PURPOSE: this wrapper is the iframe's own box, so the rect
                the frame reports needs no translation to position the chip/popover over it.
                The POPOVER is unconditional on railOpen (C2b): anyone who can open the site can
                comment without opening a panel first. */}
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
            // ThreadCard fires this for resolve/reopen and delete as well as for replies, so the S9
            // gate is per change (`pushed`), not per call site: a reply's push replaces this read,
            // a resolve has no push and must keep it or it would be invisible until reload.
            onChanged={({ pushed }) => filePath && void refreshUnlessPushed(filePath, pushed)}
            onFocusAnchor={scrollAnchor}
            typing={typing}
            // The send side. `sendTyping` does its own 15s-per-thread rate cap (S11) — every
            // keystroke calls it and all but one is swallowed there, so the composer needs no timer
            // and no state of its own. With no live socket both are silent no-ops.
            onTyping={sendTyping}
            onTypingStop={sendTypingStop}
            onClose={closeRail}
            onStartComment={startPageComment}
            getCurrentTime={isAudio ? getCurrentTime : undefined}
            // Highlight clicks take over from the deep link once one has happened (see revealThread):
            // the link is one-shot at mount and carries a constant nonce, while a click re-requests
            // the same thread every time and bumps the nonce to say so. Both are stable references —
            // an inline literal here re-ran ReviewRail's reveal effect on every viewer render and
            // silently dropped the pending card scroll.
            focusRequest={clickFocusRequest ?? deepLinkFocusRequest}
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
