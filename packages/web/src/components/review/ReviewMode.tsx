import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { type DOMRectLike, type Intent, parseIntent } from '@/lib/parseIntent'
import { comments, type Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { ReviewRail } from '@/components/review/ReviewRail'

type Pending = { quote: string; prefix: string; suffix: string; rect?: DOMRectLike }

// Review mode: a persistent split layout (iframe + comment rail), NOT a modal Sheet (which would
// trap focus). The iframe runs the annotate client (?glance_annotate=1); the parent consumes its
// messages via parseIntent and is the ONLY side that mutates — every write is an explicit
// parent-side user action (the confused-deputy guard).
export function ReviewMode({ site, onExit }: { site: ViewerSite; onExit: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const contentOrigin = useMemo(() => new URL(site.contentUrl).origin, [site.contentUrl])
  const src = useMemo(() => withAnnotate(site.contentUrl), [site.contentUrl])

  const [me, setMe] = useState<Me | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [selection, setSelection] = useState<Pending | null>(null)
  const [composing, setComposing] = useState<Pending | null>(null)

  // Paint the (non-orphaned) anchors back into the iframe via the trusted parent→child channel.
  const paint = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    const anchors = threads
      .filter((t) => t.anchorType === 'text' && t.quote && t.anchorStatus !== 'orphaned')
      .map((t) => ({ id: t.id, quote: t.quote as string }))
    win.postMessage({ type: 'glance:paint', anchors }, contentOrigin)
  }, [threads, contentOrigin])

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

  return (
    <div className="fixed inset-0 flex flex-col bg-background md:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        <iframe
          ref={iframeRef}
          className="size-full border-0"
          src={src}
          title={site.title ?? site.siteSlug}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
        {selection?.rect && (
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
      </div>
      <ReviewRail
        site={site}
        me={me}
        threads={threads}
        composing={composing}
        onCancelComposer={() => setComposing(null)}
        onCreate={createThread}
        onChanged={() => filePath && refresh(filePath)}
        onFocusAnchor={(quote) => iframeRef.current?.contentWindow?.postMessage({ type: 'glance:focus', quote }, contentOrigin)}
        onExit={onExit}
      />
    </div>
  )
}

function withAnnotate(u: string): string {
  const url = new URL(u)
  url.searchParams.set('glance_annotate', '1')
  return url.toString()
}
