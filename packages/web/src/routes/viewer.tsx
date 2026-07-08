import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData, useParams } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { isAudioFile } from '@/lib/audio'
import { attachDbBroker } from '@/lib/dbBroker'
import { toLogin } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { comments, type PendingAnchor, pendingToInput, type Thread } from '@/lib/comments'
import { type Intent, parseIntent } from '@/lib/parseIntent'
import { recordVisit } from '@/lib/recents'
import type { Me, ViewerSite } from '@/lib/types'
import { AudioView } from '@/components/AudioView'
import { Spinner } from '@/components/states'
import { type CanvasWidth, ViewerTopBar } from '@/components/ViewerTopBar'
import { ReviewRail, type ReviewMode } from '@/components/review/ReviewRail'
import { ViewerSidebar } from '@/components/ViewerSidebar'

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    return await api.get<ViewerSite>(`/api/sites/${params.space}/${params.site}`)
  } catch (err) {
    // 401 → sign in, returning here afterward; 403/404/410 bubble to the ErrorBoundary.
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
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
  const site = useLoaderData() as ViewerSite

  // Optional in-site file path from the route splat (`/space/site/docs/page.html`). Appended to the
  // content URL so a deep link / the directory-listing fallback opens that specific file; '' = root.
  const sitePath = useParams()['*'] ?? ''

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  // Latest file path reported by the iframe's 'ready' intent, stashed unconditionally so the
  // me-resolution effect below can flush it even when 'ready' beats the /api/auth/me fetch on a
  // fresh load (see the recordVisit gate in the intent handler).
  const lastReadyPathRef = useRef<string | null>(null)
  const contentOrigin = useMemo(() => new URL(site.contentUrl).origin, [site.contentUrl])
  const src = useMemo(() => withAnnotate(appendPath(site.contentUrl, sitePath)), [site.contentUrl, sitePath])
  // Audio has no HTML document to frame — it gets a native player instead of the sandboxed
  // iframe, and (unlike the iframe src) no ?glance_annotate param: that flag only triggers the
  // HTML-injection transform in content.ts, which never applies to audio.
  const isAudio = useMemo(() => isAudioFile(sitePath), [sitePath])
  const audioSrc = useMemo(() => appendPath(site.contentUrl, sitePath), [site.contentUrl, sitePath])

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
  const filePath = isAudio ? sitePath : resolvedFilePath
  const [threads, setThreads] = useState<Thread[]>([])
  const [composing, setComposing] = useState<PendingAnchor | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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

  const refresh = useCallback(
    async (fp: string) => {
      try {
        setThreads(await comments.list(site, fp))
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Failed to load comments')
      }
    },
    [site],
  )

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
        setResolvedFilePath(intent.filePath)
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
  }, [contentOrigin, me, review, site.spaceSlug, site.siteSlug, site.title])

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

  // Load threads once the frame reports ready — powers the toolbar count badge before review opens,
  // and seeds the rail. The frame is already mounted, so this is just a fetch, never a reload; the
  // rail then stays fresh via onCreate/onChanged.
  useEffect(() => {
    if (filePath) refresh(filePath)
  }, [filePath, refresh])

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

  async function createThread(body: string) {
    if (!filePath || !composing) return
    try {
      await comments.create(site, pendingToInput(filePath, body, composing))
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
      />

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
              <AudioView src={audioSrc} fileName={sitePath.split('/').pop() ?? sitePath} audioRef={audioRef} />
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
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation-by-user-activation"
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
  return contentUrl + filePath.split('/').map(encodeURIComponent).join('/')
}
