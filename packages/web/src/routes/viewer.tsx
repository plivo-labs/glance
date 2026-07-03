import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { type LoaderFunctionArgs, useLoaderData, useParams } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import { comments, type Thread } from '@/lib/comments'
import { type DOMRectLike, type Intent, parseIntent } from '@/lib/parseIntent'
import type { Me, ViewerSite } from '@/lib/types'
import { Spinner } from '@/components/states'
import { PreviewToolbar } from '@/components/PreviewToolbar'
import { ReviewRail } from '@/components/review/ReviewRail'
import { Button } from '@/components/ui/button'

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    return await api.get<ViewerSite>(`/api/sites/${params.space}/${params.site}`)
  } catch (err) {
    // 401 → sign in, returning here afterward; 403/404/410 bubble to the ErrorBoundary.
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

type Pending = { quote: string; prefix: string; suffix: string; rect?: DOMRectLike }

// One persistent iframe hosts the deployed HTML for the whole tab; opening comments slides a rail
// in beside it WITHOUT reloading the frame. Every site is review-capable (there is no public tier),
// so the iframe always runs the annotate client (?glance_annotate=1) and toggling comments is a pure
// layout change — only the rail and the in-page affordances are gated on `review`.
export function Component() {
  const site = useLoaderData() as ViewerSite

  // Optional in-site file path from the route splat (`/space/site/docs/page.html`). Appended to the
  // content URL so a deep link / the directory-listing fallback opens that specific file; '' = root.
  const sitePath = useParams()['*'] ?? ''

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const contentOrigin = useMemo(() => new URL(site.contentUrl).origin, [site.contentUrl])
  const src = useMemo(() => withAnnotate(appendPath(site.contentUrl, sitePath)), [site.contentUrl, sitePath])

  const [review, setReview] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [selection, setSelection] = useState<Pending | null>(null)
  const [composing, setComposing] = useState<Pending | null>(null)

  // Paint the (non-orphaned) anchors back into the iframe via the trusted parent→child channel —
  // only while reviewing; leaving review repaints with [] so the highlights clear.
  const paint = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    const anchors = review
      ? threads
          .filter((t) => t.anchorType === 'text' && t.quote && t.anchorStatus !== 'orphaned')
          .map((t) => ({ id: t.id, quote: t.quote as string }))
      : []
    win.postMessage({ type: 'glance:paint', anchors }, contentOrigin)
  }, [threads, contentOrigin, review])

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

  // Actionable count for the toolbar badge: open, still-anchored threads (mirrors the rail's default
  // "open" list; resolved + outdated/orphaned are excluded).
  const openCount = useMemo(
    () => threads.filter((t) => t.status === 'open' && t.anchorStatus !== 'orphaned').length,
    [threads],
  )

  // Listen for intents from the iframe. parseIntent re-validates origin+source; it is a filter,
  // not a trust oracle — nothing here writes without a subsequent explicit user action.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const intent: Intent | null = parseIntent(e, { origin: contentOrigin, source: iframeRef.current?.contentWindow ?? null })
      if (!intent) return
      if (intent.type === 'ready') setFilePath(intent.filePath)
      else if (intent.type === 'select') setSelection({ quote: intent.quote, prefix: intent.prefix, suffix: intent.suffix, rect: intent.rect })
      else if (intent.type === 'clear') setSelection(null)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [contentOrigin])

  useEffect(() => {
    api.get<Me>('/api/auth/me').then(setMe).catch(() => setMe(null))
  }, [])

  // Load threads once the frame reports ready — powers the toolbar count badge before review opens,
  // and seeds the rail. The frame is already mounted, so this is just a fetch, never a reload; the
  // rail then stays fresh via onCreate/onChanged.
  useEffect(() => {
    if (filePath) refresh(filePath)
  }, [filePath, refresh])

  useEffect(paint, [paint])

  const startComposer = () => {
    setComposing(selection)
    setSelection(null)
  }

  async function createThread(body: string) {
    if (!filePath || !composing) return
    try {
      await comments.create(site, { filePath, body, quote: composing.quote, prefix: composing.prefix, suffix: composing.suffix })
      setComposing(null)
      await refresh(filePath)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add comment')
    }
  }

  function exitReview() {
    setReview(false)
    setSelection(null)
    setComposing(null)
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background md:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        <iframe
          ref={iframeRef}
          className="size-full border-0"
          src={src}
          title={site.title ?? site.siteSlug}
          onLoad={() => setLoaded(true)}
          // allow-top-navigation-by-user-activation: lets the directory-listing links (target=_top)
          // break out to the app route on a user click, so the address bar updates. Gesture-gated,
          // so iframed content can't silently redirect the tab.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation-by-user-activation"
        />
        {review && selection?.rect && (
          <Button
            size="sm"
            className="absolute z-10 shadow-lg"
            style={{ top: selection.rect.top + selection.rect.height + 6, left: selection.rect.left }}
            onClick={startComposer}
          >
            <MessageSquarePlus className="size-3.5" />
            Comment
          </Button>
        )}
        {!loaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
            <Spinner className="size-6" />
            <span className="text-sm">Loading preview…</span>
          </div>
        )}
      </div>

      {review ? (
        <ReviewRail
          site={site}
          me={me}
          threads={threads}
          composing={composing}
          onCancelComposer={() => setComposing(null)}
          onCreate={createThread}
          onChanged={() => filePath && refresh(filePath)}
          onFocusAnchor={(quote) => iframeRef.current?.contentWindow?.postMessage({ type: 'glance:focus', quote }, contentOrigin)}
          onExit={exitReview}
        />
      ) : (
        <PreviewToolbar site={site} commentCount={openCount} onReview={() => setReview(true)} />
      )}
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
  return contentUrl + filePath.split('/').map(encodeURIComponent).join('/')
}
