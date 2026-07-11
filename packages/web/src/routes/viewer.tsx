import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { isAudioFile } from '@/lib/audio'
import { attachDbBroker } from '@/lib/dbBroker'
import { cn } from '@/lib/utils'
import { comments, type PendingAnchor, pendingToInput, type Thread } from '@/lib/comments'
import { type Intent, parseIntent } from '@/lib/parseIntent'
import { encodePathSegments } from '@/lib/paths'
import { type ArbiterEvent, type ArbiterState, type Decision, initialArbiter, stepArbiter } from '@/lib/prefetchArbiter'
import { recordVisit } from '@/lib/recents'
import type { Me } from '@/lib/types'
import { loadViewer, PREFETCH_FAILED, type PrefetchResult, type ViewerLoaderData } from '@/lib/viewerLoader'
import { AudioView } from '@/components/AudioView'
import { Spinner } from '@/components/states'
import { CommandPalette } from '@/components/CommandPalette'
import { type CanvasWidth, ViewerTopBar } from '@/components/ViewerTopBar'
import { ReviewRail, type ReviewMode } from '@/components/review/ReviewRail'
import { ViewerSidebar } from '@/components/ViewerSidebar'

// S11: the loader resolves on SITE META alone; the comments prefetch for the predicted entry file
// is fired unawaited and rides along as a pending promise — the iframe never waits on comments.
// All the logic (401 redirect, no-prefetch-on-meta-failure, null-entry root) lives in
// lib/viewerLoader where it's unit-tested.
export async function loader({ params, request }: LoaderFunctionArgs) {
  return loadViewer({ space: params.space ?? '', site: params.site ?? '', sitePath: params['*'] ?? '', request })
}

// The paint payload the iframe understands: a text anchor (re-find quote) or an element anchor
// (re-resolve selector). Mirrors the annotate client's PaintAnchor.
type PaintMsgAnchor = { id: string; anchorType: 'text'; quote: string } | { id: string; anchorType: 'element'; selector: string }

// The recents sidebar lets a user jump straight from one open site to another via a plain
// react-router <Link> (no full reload) — the FIRST in-app case of navigating between two mounts of
// this same route. React Router keeps one component instance across param changes on a matched
// route, so without a remount all the per-site useState (threads, filePath, loaded, review, …)
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

  const [review, setReview] = useState(false)
  // Within review, Read = normal browsing + text-select-to-comment; Annotate = also hover/click an
  // element to pinpoint it. Default annotate on entering review so element commenting works.
  const [reviewMode, setReviewMode] = useState<ReviewMode>('annotate')
  const [width, setWidth] = useState<CanvasWidth>('full')
  const [loaded, setLoaded] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  // The HTML iframe only learns its file path from the annotate client's 'ready' postMessage
  // (never fires for non-HTML) — `filePath` below is what the rest of the viewer (comments,
  // rail) actually reads; for audio there's no message to wait for, so it's the splat itself.
  const [resolvedFilePath, setResolvedFilePath] = useState<string | null>(null)
  const filePath = isAudio ? entryPath : resolvedFilePath
  const [threads, setThreads] = useState<Thread[]>([])
  const [composing, setComposing] = useState<PendingAnchor | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)

  // Paint anchors back into the iframe via the trusted parent→child channel — only while reviewing;
  // leaving review repaints with [] so highlights/overlays clear. Text anchors re-find their quote
  // in the rendered DOM; element anchors re-resolve their selector to an overlay box. Either kind an
  // iframe can't locate simply isn't painted (element misses come back as orphaned).
  const paint = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    const anchors: PaintMsgAnchor[] = review
      ? threads.flatMap((t): PaintMsgAnchor[] => {
          if (t.anchorType === 'text' && t.quote) return [{ id: t.id, anchorType: 'text', quote: t.quote }]
          if (t.anchorType === 'element' && t.anchor) return [{ id: t.id, anchorType: 'element', selector: t.anchor.selector }]
          return []
        })
      : []
    win.postMessage({ type: 'glance:paint', anchors }, contentOrigin)
  }, [threads, contentOrigin, review])

  // Tell the iframe which mode it's in: read outside review, else the review sub-mode. Gates the
  // in-page pinpoint hover/click (the annotate client ignores it in read mode). Re-posts live on
  // toggle; `loaded` gates the first post until the client has booted its message listener.
  const postMode = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !loaded) return
    win.postMessage({ type: 'glance:mode', mode: review ? reviewMode : 'read' }, contentOrigin)
  }, [review, reviewMode, loaded, contentOrigin])

  // The element the user is currently commenting on, while the composer is open. Its selector is
  // pushed to the iframe so the annotate client paints a PERSISTENT selection outline on it; the
  // transient hover box alone would vanish the moment the pointer moves off to the composer. null
  // (text pending / composer closed) clears it.
  const pendingSelector = useMemo(() => (composing?.kind === 'element' ? composing.anchor.selector : null), [composing])

  const postPending = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !loaded) return
    win.postMessage({ type: 'glance:pending', selector: pendingSelector }, contentOrigin)
  }, [pendingSelector, loaded, contentOrigin])

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
      // One click, one select: outside review these are no-ops (nothing to stash without a rail to
      // open into); in review each intent opens the composer directly on its anchor, replacing
      // whatever was already being composed but leaving its typed draft alone (ReviewRail renders
      // Composer unkeyed, so swapping `composing` reparents the anchor without remounting the text).
      else if (review && intent.type === 'select') setComposing({ kind: 'text', quote: intent.quote })
      else if (review && intent.type === 'pinpoint') setComposing({ kind: 'element', anchor: intent.anchor })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [contentOrigin, me, review, site.spaceSlug, site.siteSlug, site.title, dispatch, loadThreads])

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
  useEffect(postMode, [postMode])
  useEffect(postPending, [postPending])

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

  // Focus an anchor in the iframe: element → scroll its selector into view; text → its quote.
  const focusAnchor = useCallback(
    (thread: Thread) => {
      const win = iframeRef.current?.contentWindow
      if (!win) return
      if (thread.anchorType === 'element' && thread.anchor)
        win.postMessage({ type: 'glance:focus', selector: thread.anchor.selector }, contentOrigin)
      else if (thread.quote) win.postMessage({ type: 'glance:focus', quote: thread.quote }, contentOrigin)
    },
    [contentOrigin],
  )

  // Deep-link contract (a notification click lands here): `?review=1` opens the review rail and
  // `?thread=<id>` focuses that thread — scroll the iframe to its anchor + its rail card into view,
  // once the frame is loaded and that file's threads are in. `filePath` in the notification's URL
  // path ensures the right file (and thus the thread) is what loads. Fires at most once.
  const [searchParams] = useSearchParams()
  const wantReview = searchParams.get('review') === '1'
  const deepLinkThreadId = searchParams.get('thread')
  const deepLinkFocused = useRef(false)

  useEffect(() => {
    if (wantReview) setReview(true)
  }, [wantReview])

  useEffect(() => {
    if (deepLinkFocused.current || !deepLinkThreadId || !review || !loaded) return
    const target = threads.find((t) => t.id === deepLinkThreadId)
    if (!target) return
    deepLinkFocused.current = true
    // Scroll the iframe to the anchor; the rail reveals + scrolls the thread card itself (ReviewRail
    // owns the open/resolved filter, so it can un-hide a resolved target).
    focusAnchor(target)
  }, [deepLinkThreadId, review, loaded, threads, focusAnchor])

  async function createThread(body: string, mentions: string[]) {
    if (!filePath || !composing) return
    try {
      await comments.create(site, pendingToInput(filePath, body, composing), mentions)
      setComposing(null)
      await refresh(filePath)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add comment')
    }
  }

  // Voice sibling of createThread: the anchor fields come from the same pending anchor (body is the
  // server-side transcript, so it's dropped from the multipart payload).
  async function createVoiceThread(blob: Blob) {
    if (!filePath || !composing) return
    try {
      const { body: _body, ...fields } = pendingToInput(filePath, '', composing)
      await comments.createVoice(site, blob, fields)
      setComposing(null)
      await refresh(filePath)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add voice comment')
    }
  }

  function exitReview() {
    setReview(false)
    setComposing(null)
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <ViewerTopBar
        site={site}
        sitePath={sitePath}
        review={review}
        mode={reviewMode}
        onMode={setReviewMode}
        width={width}
        onWidth={setWidth}
        commentCount={openCount}
        onReview={() => setReview(true)}
        onExit={exitReview}
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
        {/* Letterbox canvas: the iframe is constrained to the chosen width and centered; the
            surrounding muted area is the letterbox. The loading overlay lives inside the constrained
            wrapper so its coords still match the iframe viewport. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 justify-center bg-muted/20">
          <div className={cn('relative h-full w-full', WIDTH_CLASS[width])}>
            {isAudio ? (
              <AudioView src={audioSrc} fileName={(entryPath ?? '').split('/').pop() ?? ''} audioRef={audioRef} />
            ) : (
              <iframe
                ref={iframeRef}
                className="size-full border-0 bg-background"
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
            {!isAudio && !loaded && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
                <Spinner className="size-6" />
                <span className="text-sm">Loading preview…</span>
              </div>
            )}
          </div>
        </div>

        {review && (
          <ReviewRail
            site={site}
            me={me}
            threads={threads}
            composing={composing}
            onCancelComposer={() => setComposing(null)}
            onCreate={createThread}
            onCreateVoice={createVoiceThread}
            onChanged={() => filePath && refresh(filePath)}
            onFocusAnchor={focusAnchor}
            onStartComment={isAudio ? startPageComment : undefined}
            getCurrentTime={isAudio ? getCurrentTime : undefined}
            focusThreadId={deepLinkThreadId}
          />
        )}
      </div>
    </div>
  )
}

// Tailwind max-width per canvas width (letterboxing the rest). `full` = no constraint.
const WIDTH_CLASS: Record<CanvasWidth, string> = { full: 'max-w-none', wide: 'max-w-5xl', reading: 'max-w-3xl' }

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
