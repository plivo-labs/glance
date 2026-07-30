import { MessageSquarePlus } from 'lucide-react'
import type { Anchor, PopoverState } from '@/lib/commentPopover'
import type { DOMRectLike } from '@/lib/parseIntent'
import type { MentionUser } from '@/lib/mentions'
import { Composer } from '@/components/review/Composer'

// In-page comment affordance: a chip pinned to the selection, and the popover its click opens.
// Pure rendering of the A1 reducer's state (lib/commentPopover) — every transition is the parent's.
//
// MOUNT POINT IS LOAD-BEARING: both are absolutely positioned inside the SAME wrapper div that
// holds the iframe (viewer.tsx's `relative h-full w-full`). The iframe fills that wrapper, so the
// rect it reports in ITS viewport coords is already this element's coordinate space — 1:1 px, no
// scale math, no getBoundingClientRect of the iframe. Mounting anywhere else would reintroduce all
// three.
const GAP = 8
const below = (r: DOMRectLike): React.CSSProperties => ({ top: r.top + r.height + GAP, left: r.left })

export function CommentPopover({
  chip,
  composer,
  onActivate,
  onDismiss,
  onSubmit,
  onSubmitVoice,
  loadMentions,
  onDirtyChange,
}: {
  chip: Anchor | null
  composer: PopoverState['composer']
  onActivate: () => void
  // Escape / Cancel — the parent's 'dismiss'.
  onDismiss: () => void
  onSubmit: (body: string, mentions: string[]) => void | Promise<void>
  onSubmitVoice: (blob: Blob) => void | Promise<void>
  loadMentions?: () => Promise<MentionUser[]>
  // Whether the draft has text, reported up because `dirty` is an INPUT to the reducer (a typed
  // draft survives an incidental re-selection). The draft itself stays in the Composer.
  onDirtyChange?: (dirty: boolean) => void
}) {
  return (
    <>
      {chip && (
        <button
          type="button"
          aria-label="Comment on selection"
          onClick={onActivate}
          style={below(chip.rect)}
          className="absolute z-20 inline-flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 font-medium text-popover-foreground text-xs shadow-md hover:bg-accent"
        >
          <MessageSquarePlus className="size-3.5" />
          Comment
        </button>
      )}
      {composer && (
        <div
          // A new composer id is a new composer: remounting drops the previous draft, which is what
          // the reducer means when a click on the chip mints a fresh one over an open (even dirty) box.
          key={composer.id}
          style={below(composer.anchor.rect)}
          className="absolute z-30 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
          // Escape closes the popover — but ONLY once the Composer hasn't already claimed it for its
          // open mention menu (it preventDefaults there). Menu first, popover on the next press.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) onDismiss()
          }}
        >
          <p className="mb-2 line-clamp-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">
            “{composer.anchor.quote}”
          </p>
          <Composer
            autoFocus
            placeholder="Add a comment…"
            submitLabel="Comment"
            loadMentions={loadMentions}
            onSubmit={onSubmit}
            onSubmitVoice={onSubmitVoice}
            onCancel={onDismiss}
            onDirtyChange={onDirtyChange}
          />
        </div>
      )}
    </>
  )
}
