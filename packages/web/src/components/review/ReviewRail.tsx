import { MessageSquarePlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { comments, type PendingAnchor, type Thread, type ThreadStatus } from '@/lib/comments'
import { timestampPrefix } from '@/lib/audio'
import type { Me, ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AnchorChip } from '@/components/review/AnchorChip'
import { Composer } from '@/components/review/Composer'
import { ThreadCard } from '@/components/review/ThreadCard'

// Read·Annotate lives on the ViewerTopBar; the type is shared from here (the rail owns the review
// vocabulary).
export type ReviewMode = 'read' | 'annotate'

const byUpdatedDesc = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

// Persistent right-rail for review mode: filter (open/resolved), an anchor-prefilled composer on
// select/pinpoint, and the thread list. Mode toggle + Done live in the ViewerTopBar.
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
  onStartComment,
  getCurrentTime,
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
  // Set only for content with no DOM to select in (the audio view) — offers a plain "Add
  // comment" trigger that opens the composer with a bare page anchor, no text/element pending.
  onStartComment?: () => void
  // Set only for the audio view — lets the composer's timestamp button read the player's
  // current position (via a ref, at click time) without any state/effect wiring.
  getCurrentTime?: () => number
}) {
  const [filter, setFilter] = useState<ThreadStatus>('open')

  const active = useMemo(() => threads.filter((t) => t.status === filter).sort(byUpdatedDesc), [threads, filter])

  return (
    <aside className="flex max-h-[55vh] w-full shrink-0 flex-col border-t bg-background md:max-h-none md:h-full md:w-[360px] md:border-t-0 md:border-l">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-semibold text-sm">Comments</h2>
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
