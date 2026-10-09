import { MessageSquarePlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { comments, type PendingAnchor, type Thread, type ThreadStatus } from '@/lib/comments'
import { timestampPrefix } from '@/lib/audio'
import type { Me, ViewerSite } from '@/lib/types'
import { type RevealRequest, shouldReveal } from '@/lib/viewerCommands'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/review/Composer'
import { ThreadCard } from '@/components/review/ThreadCard'

const byUpdatedDesc = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

// Stable reference for the `typing` default — a fresh `[]` every render would defeat memoization.
const NO_TYPING: TypingPing[] = []

/** One "still typing" ping, as the room fans it out (S10): the viewer it came from, the thread it
 *  names, and an ABSOLUTE expiry. No display name — attribution is the rail's job (typistOn), so
 *  nothing a sender could choose is ever rendered. */
export type TypingPing = { viewerId: string; threadId: string; expiresAt: number }

// Resize bounds: never narrower than the classic default, never wider than half the screen.
export const RAIL_MIN_WIDTH = 360
export const clampRailWidth = (width: number, viewportWidth: number): number =>
  Math.min(Math.max(width, RAIL_MIN_WIDTH), Math.max(RAIL_MIN_WIDTH, Math.floor(viewportWidth / 2)))

// The comments rail: the filter (open/resolved), an anchor-prefilled composer on select, and the
// thread list. C2b: this is just a panel now (commenting is unconditional in viewer.tsx; the
// on-page highlights ride with this panel) — its own ✕ closes it, alongside the ViewerTopBar's
// Comments toggle.
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
  onClose,
  onStartComment,
  getCurrentTime,
  focusRequest,
  typing = NO_TYPING,
  onTyping,
  onTypingStop,
}: {
  site: ViewerSite
  me: Me | null
  threads: Thread[]
  composing: PendingAnchor | null
  onCancelComposer: () => void
  onCreate: (body: string, mentions: string[]) => void | Promise<void>
  // Voice sibling of onCreate: submits the composer's recording as a voice thread on the same anchor.
  onCreateVoice: (blob: Blob) => void | Promise<void>
  // Passed straight through to every ThreadCard — see the `pushed` note on its own prop.
  onChanged: (change: { pushed: boolean }) => void
  onFocusAnchor: (thread: Thread) => void
  // The rail's own close affordance (its header ✕) — the ViewerTopBar's Comments toggle is the
  // other way to close it; both land on the same handler in viewer.tsx.
  onClose: () => void
  // A notification deep-link or highlight click's target thread (S11 / C1b): reveal it regardless of
  // the open/resolved filter (switch to its tab) and scroll its card into view. Keyed on `nonce`,
  // not just `id` — see shouldReveal — so the SAME thread can be re-requested (e.g. clicking the
  // same highlight twice) and still reveal.
  focusRequest?: RevealRequest | null
  // Opens the composer on a bare page anchor — no text/element pending. REQUIRED, for every
  // content type (#112): its optionality used to BE the gate that limited page comments to the
  // audio view, so the type is what keeps it ungated. Text selection still composes in the
  // popover; this is the "about the page as a whole" path.
  onStartComment: () => void
  // Live "still typing" pings from the other viewers on this site (S12). Empty by default — a rail
  // rendered without a socket behind it simply never shows an indicator.
  typing?: TypingPing[]
  // The send side of the same feature, per thread. Optional for the same reason `typing` is: with no
  // socket behind the rail there is nowhere to send, and no component test has to care.
  onTyping?: (threadId: string) => void
  onTypingStop?: (threadId: string) => void
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

  // C22 — an indicator dies on a LOCAL clock. Nothing retracts a ping: a closed laptop just stops
  // sending, and the room schedules nothing (it would pay for a timer per typist). So the receiver
  // counts the expiry down itself — this wakes at the earliest one still ahead and moves the rail's
  // clock to it. It advances to `next` rather than to Date.now() so "expired is expired" holds
  // however late the timer actually ran.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const next = Math.min(...typing.filter((p) => p.expiresAt > now).map((p) => p.expiresAt))
    if (!Number.isFinite(next)) return // nothing live — no timer at all until the next ping arrives
    const timer = setTimeout(() => setNow(next), Math.max(0, next - Date.now()))
    return () => clearTimeout(timer)
  }, [typing, now])

  /** Who is replying on this thread, or null. The wire carries an ID, so the name comes from the
   *  thread's OWN participants — the rail already had them. An id it does not recognise stays
   *  nameless (ThreadCard renders "Someone"), because a name the payload could pick would be a name
   *  anyone with a socket could claim. */
  const typistOn = (t: Thread) => {
    const ping = typing.find((p) => p.threadId === t.id && p.expiresAt > now)
    return ping ? { name: t.comments.find((c) => c.authorId === ping.viewerId)?.author ?? null } : null
  }

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
  // churn instead of relying on every current and future caller (e.g. a highlight click) to memoize.
  const revealedNonceRef = useRef<number | null>(null)
  /* oxlint-disable react-hooks/exhaustive-deps -- the primitive deps ARE the fix (above) — depending on the focusRequest object re-runs this on every caller re-render and cancels the pending rAF scroll. */
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
  /* oxlint-enable react-hooks/exhaustive-deps */

  return (
    <aside
      className="relative flex max-h-[55vh] w-full shrink-0 flex-col border-t bg-background md:max-h-none md:h-full md:w-[var(--rail-w)] md:border-t-0 md:border-l"
      style={{ '--rail-w': `${railWidth}px` } as React.CSSProperties}
    >
      {/* Left-edge drag handle (desktop only): straddles the border so it's easy to grab.
          Keyboard: arrow keys nudge the width (WAI-ARIA window-splitter pattern). */}
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an <hr> can't be an interactive resizer (tabIndex/onKeyDown/onPointerDown); this is the WAI-ARIA window-splitter pattern, not a static separator.
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

      {/* The rail composes PAGE comments only ("Add comment"). A text selection composes in the
          popover over the content, and element comments no longer exist as a creation path — so
          there is no anchor preview to draw here, only the composer.

          A BUTTON, not an always-mounted textarea (#112): `composing` here and the popover's own
          composer are independent states (viewer.tsx:86,94) — nothing clears one when the other
          opens — so a permanently-open textarea would make "two live drafts, no rule for which
          wins" the DEFAULT state on every text selection, and would spend ~100px of a 55vh mobile
          bottom sheet on every reader who came only to read. */}
      {composing ? (
        <div className="border-b bg-muted/40 p-3">
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
        <div className="border-b p-3">
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={onStartComment}>
            <MessageSquarePlus className="size-3.5" />
            Add comment
          </Button>
        </div>
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
        {/* Both creation paths get named (#112). Keyed on getCurrentTime, which is the one prop
            that is still genuinely audio-only — the audio view has no DOM to select text in, so
            offering it a "select text" path would be a lie. */}
        {active.length === 0 && !composing && (
          <p className="px-1 py-8 text-center text-muted-foreground text-sm">
            {filter !== 'open'
              ? 'No resolved threads.'
              : getCurrentTime
                ? 'Add a comment above — optionally with a timestamp.'
                : 'Add a comment above, or select text on the page to anchor one.'}
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
            typing={typistOn(t)}
            onTyping={onTyping && (() => onTyping(t.id))}
            onTypingStop={onTypingStop && (() => onTypingStop(t.id))}
          />
        ))}
      </div>
    </aside>
  )
}
