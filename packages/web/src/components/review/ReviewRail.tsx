import { MessageSquarePlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { comments, type PendingAnchor, type Thread, type ThreadStatus } from '@/lib/comments'
import { timestampPrefix } from '@/lib/audio'
import type { Me, ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { AnchorChip } from '@/components/review/AnchorChip'
import { Composer } from '@/components/review/Composer'
import { ThreadCard } from '@/components/review/ThreadCard'

export type ReviewMode = 'read' | 'annotate'

const MODES = [
  { value: 'read', label: 'Read', title: 'Browse the page' },
  { value: 'annotate', label: 'Annotate', title: 'Click an element to comment' },
] as const satisfies readonly { value: ReviewMode; label: string; title: string }[]

const byUpdatedDesc = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

// Resize bounds: never narrower than the classic default, never wider than half the screen.
export const RAIL_MIN_WIDTH = 360
export const clampRailWidth = (width: number, viewportWidth: number): number =>
  Math.min(Math.max(width, RAIL_MIN_WIDTH), Math.max(RAIL_MIN_WIDTH, Math.floor(viewportWidth / 2)))

// Persistent right-rail for review mode: the Read·Annotate toggle in its header, filter
// (open/resolved), an anchor-prefilled composer on select/pinpoint, and the thread list.
// Done (exit review) lives in the ViewerTopBar.
export function ReviewRail({
  site,
  me,
  mode,
  onMode,
  threads,
  composing,
  onCancelComposer,
  onCreate,
  onCreateVoice,
  onChanged,
  onFocusAnchor,
  onStartComment,
  getCurrentTime,
  focusThreadId,
}: {
  site: ViewerSite
  me: Me | null
  // Read·Annotate toggle in the rail header. Unset for content with no DOM to annotate (the
  // audio view), which hides the toggle.
  mode?: ReviewMode
  onMode?: (mode: ReviewMode) => void
  threads: Thread[]
  composing: PendingAnchor | null
  onCancelComposer: () => void
  onCreate: (body: string, mentions: string[]) => void | Promise<void>
  // Voice sibling of onCreate: submits the composer's recording as a voice thread on the same anchor.
  onCreateVoice: (blob: Blob) => void | Promise<void>
  onChanged: () => void
  onFocusAnchor: (thread: Thread) => void
  // A notification deep-link's target thread (S11): reveal it regardless of the open/resolved
  // filter (switch to its tab) and scroll its card into view, once, when it lands in `threads`.
  focusThreadId?: string | null
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

  // Deep-link reveal: when a notification's target thread arrives, switch to its status tab (so a
  // resolved thread isn't hidden by the default 'open' filter) and scroll its card into view. Fires
  // once per target id; the rAF lets the tab switch render the card before we scroll to it.
  const revealedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusThreadId || revealedRef.current === focusThreadId) return
    const target = threads.find((t) => t.id === focusThreadId)
    if (!target) return
    revealedRef.current = focusThreadId
    setFilter(target.status)
    const raf = requestAnimationFrame(() =>
      document.getElementById(`thread-${focusThreadId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
    return () => cancelAnimationFrame(raf)
  }, [focusThreadId, threads])

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
        {mode && onMode && <Segmented value={mode} options={MODES} onChange={onMode} />}
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
                : 'Select text — or click an element in Annotate mode — to comment.'}
          </p>
        )}
        {active.map((t) => (
          <ThreadCard key={t.id} site={site} me={me} thread={t} onChanged={onChanged} onFocusAnchor={onFocusAnchor} />
        ))}
      </div>
    </aside>
  )
}
