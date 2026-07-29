import { MessageSquarePlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { comments, type PendingAnchor, type Thread, type ThreadStatus } from '@/lib/comments'
import { timestampPrefix } from '@/lib/audio'
import type { Me, ViewerSite } from '@/lib/types'
import { type RevealRequest, shouldReveal } from '@/lib/viewerCommands'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AnchorChip } from '@/components/review/AnchorChip'
import { Composer } from '@/components/review/Composer'
import { ThreadCard } from '@/components/review/ThreadCard'

const byUpdatedDesc = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

// Resize bounds: never narrower than the classic default, never wider than half the screen.
export const RAIL_MIN_WIDTH = 360
export const clampRailWidth = (width: number, viewportWidth: number): number =>
  Math.min(Math.max(width, RAIL_MIN_WIDTH), Math.max(RAIL_MIN_WIDTH, Math.floor(viewportWidth / 2)))

// The comments rail: the filter (open/resolved), an anchor-prefilled composer on select, and the
// thread list. C2b: this is just a panel now (badges/painting/commenting are unconditional in
// viewer.tsx) — its own ✕ closes it, alongside the ViewerTopBar's Comments toggle.
export function ReviewRail({
  site,
  me,
  threads,
  composing,
  onCancelComposer,
  onCreate,
  onCreateVoice,
  onChanged,
  onFocusAnchor,
  onHoverThread,
  onClose,
  onStartComment,
  getCurrentTime,
  focusRequest,
}: {
  site: ViewerSite
  me: Me | null
  threads: Thread[]
  composing: PendingAnchor | null
  onCancelComposer: () => void
  onCreate: (body: string, mentions: string[]) => void | Promise<void>
  // Voice sibling of onCreate: submits the composer's recording as a voice thread on the same anchor.
  onCreateVoice: (blob: Blob) => void | Promise<void>
  onChanged: () => void
  onFocusAnchor: (thread: Thread) => void
  // Mirrors BadgeOverlay's onHoverChange, threaded down to each ThreadCard (B3b-hard).
  onHoverThread: (ids: string[] | null) => void
  // The rail's own close affordance (its header ✕) — the ViewerTopBar's Comments toggle is the
  // other way to close it; both land on the same handler in viewer.tsx.
  onClose: () => void
  // A notification deep-link or badge click's target thread (S11 / C1b): reveal it regardless of
  // the open/resolved filter (switch to its tab) and scroll its card into view. Keyed on `nonce`,
  // not just `id` — see shouldReveal — so the SAME thread can be re-requested (e.g. a repeated
  // badge click) and still reveal.
  focusRequest?: RevealRequest | null
  // Set only for content with no DOM to select in (the audio view) — offers a plain "Add
  // comment" trigger that opens the composer with a bare page anchor, no text/element pending.
  onStartComment?: () => void
  // Set only for the audio view — lets the composer's timestamp button read the player's
  // current position (via a ref, at click time) without any state/effect wiring.
  getCurrentTime?: () => number
}) {
  const [filter, setFilter] = useState<ThreadStatus>('open')

  // Desktop rail width, drag-resizable via the left-edge handle: starts at the classic 360px and
  // clamps to [360, half the viewport]. Applied through a CSS var consumed only at md+ so the
  // mobile bottom-sheet layout (w-full) is untouched. Pointer capture keeps the drag alive over
  // the content iframe (which otherwise swallows pointermove and freezes the resize).
  const [railWidth, setRailWidth] = useState(RAIL_MIN_WIDTH)
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startWidth = railWidth
    const onMove = (ev: PointerEvent) =>
      setRailWidth(clampRailWidth(startWidth + (startX - ev.clientX), window.innerWidth))
    const target = e.currentTarget
    target.addEventListener('pointermove', onMove)
    target.addEventListener(
      'pointerup',
      () => target.removeEventListener('pointermove', onMove),
      { once: true },
    )
  }

  const active = useMemo(() => threads.filter((t) => t.status === filter).sort(byUpdatedDesc), [threads, filter])

  // Reveal: when a requested thread arrives, switch to its status tab (so a resolved thread isn't
  // hidden by the default 'open' filter) and scroll its card into view. Guarded by NONCE, not id
  // (shouldReveal) — a re-request of the same thread with a bumped nonce reveals again, an
  // unchanged nonce across an unrelated re-render does not. The rAF lets the tab switch render the
  // card before we scroll to it.
  //
  // Deps are the request's own PRIMITIVES (id, nonce), not the `focusRequest` object itself — a
  // caller that builds `{ id, nonce }` inline (as viewer.tsx's one-shot deep link does) hands us a
  // new object reference on every one of ITS renders even when id/nonce haven't changed; keying on
  // the object would rerun this effect on every unrelated parent re-render, whose cleanup cancels
  // the pending rAF before it fires and the rerun then no-ops on the unchanged nonce — silently
  // dropping the scroll. Keying on the primitives makes this effect immune to caller identity
  // churn instead of relying on every current and future caller (e.g. a badge click) to memoize.
  const revealedNonceRef = useRef<number | null>(null)
  useEffect(() => {
    const target = focusRequest ? threads.find((t) => t.id === focusRequest.id) : undefined
    if (!focusRequest || !shouldReveal(focusRequest, revealedNonceRef.current, !!target)) return
    revealedNonceRef.current = focusRequest.nonce
    setFilter(target!.status)
    const raf = requestAnimationFrame(() =>
      document.getElementById(`thread-${focusRequest.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
    return () => cancelAnimationFrame(raf)
  }, [focusRequest?.id, focusRequest?.nonce, threads])

  return (
    <aside
      className="relative flex max-h-[55vh] w-full shrink-0 flex-col border-t bg-background md:max-h-none md:h-full md:w-[var(--rail-w)] md:border-t-0 md:border-l"
      style={{ '--rail-w': `${railWidth}px` } as React.CSSProperties}
    >
      {/* Left-edge drag handle (desktop only): straddles the border so it's easy to grab.
          Keyboard: arrow keys nudge the width (WAI-ARIA window-splitter pattern). */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> can't be an interactive resizer. */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize comments rail"
        aria-valuenow={railWidth}
        aria-valuemin={RAIL_MIN_WIDTH}
        onPointerDown={onResizeStart}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const delta = e.key === 'ArrowLeft' ? 24 : -24
          setRailWidth((w) => clampRailWidth(w + delta, window.innerWidth))
        }}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none hover:bg-primary/30 focus-visible:bg-primary/40 active:bg-primary/40 md:block"
      />
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-semibold text-sm">Comments</h2>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Close comments" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </header>

      {composing ? (
        <div className="border-b bg-muted/40 p-3">
          {composing.kind !== 'page' && (
            <div className="mb-2">
              {composing.kind === 'element' ? (
                <AnchorChip tag={composing.anchor.tag} preview={composing.anchor.preview} />
              ) : (
                <p className="line-clamp-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">“{composing.quote}”</p>
              )}
            </div>
          )}
          <Composer
            autoFocus
            focusOn={composing}
            placeholder="Add a comment…"
            submitLabel="Comment"
            loadMentions={() => comments.mentionable(site)}
            onSubmit={onCreate}
            onSubmitVoice={onCreateVoice}
            onCancel={onCancelComposer}
            timestampButton={getCurrentTime ? { label: 'Insert timestamp', getPrefix: () => timestampPrefix(getCurrentTime()) } : undefined}
          />
        </div>
      ) : (
        onStartComment && (
          <div className="border-b p-3">
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={onStartComment}>
              <MessageSquarePlus className="size-3.5" />
              Add comment
            </Button>
          </div>
        )
      )}

      <div className="flex gap-1 px-4 py-2">
        {(['open', 'resolved'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs capitalize transition-colors',
              filter === f ? 'bg-foreground/10 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {active.length === 0 && !composing && (
          <p className="px-1 py-8 text-center text-muted-foreground text-sm">
            {filter !== 'open'
              ? 'No resolved threads.'
              : onStartComment
                ? 'Add a comment above — optionally with a timestamp.'
                : 'Select text to comment.'}
          </p>
        )}
        {active.map((t) => (
          <ThreadCard
            key={t.id}
            site={site}
            me={me}
            thread={t}
            onChanged={onChanged}
            onFocusAnchor={onFocusAnchor}
            onHoverThread={onHoverThread}
          />
        ))}
      </div>
    </aside>
  )
}
