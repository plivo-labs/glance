import { useMemo, useState } from 'react'
import type { PendingAnchor, Thread, ThreadStatus } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
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
  onChanged,
  onFocusAnchor,
}: {
  site: ViewerSite
  me: Me | null
  threads: Thread[]
  composing: PendingAnchor | null
  onCancelComposer: () => void
  onCreate: (body: string) => void | Promise<void>
  onChanged: () => void
  onFocusAnchor: (thread: Thread) => void
}) {
  const [filter, setFilter] = useState<ThreadStatus>('open')

  const active = useMemo(() => threads.filter((t) => t.status === filter).sort(byUpdatedDesc), [threads, filter])

  return (
    <aside className="flex max-h-[55vh] w-full shrink-0 flex-col border-t bg-background md:max-h-none md:h-full md:w-[360px] md:border-t-0 md:border-l">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-semibold text-sm">Comments</h2>
      </header>

      {composing && (
        <div className="border-b bg-muted/40 p-3">
          <div className="mb-2">
            {composing.kind === 'element' ? (
              <AnchorChip tag={composing.anchor.tag} preview={composing.anchor.preview} />
            ) : (
              <p className="line-clamp-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">“{composing.quote}”</p>
            )}
          </div>
          <Composer autoFocus focusOn={composing} placeholder="Add a comment…" submitLabel="Comment" onSubmit={onCreate} onCancel={onCancelComposer} />
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
        {active.length === 0 && !composing && (
          <p className="px-1 py-8 text-center text-muted-foreground text-sm">
            {filter === 'open' ? 'Select text — or click an element in Annotate mode — to comment.' : 'No resolved threads.'}
          </p>
        )}
        {active.map((t) => (
          <ThreadCard key={t.id} site={site} me={me} thread={t} onChanged={onChanged} onFocusAnchor={onFocusAnchor} />
        ))}
      </div>
    </aside>
  )
}
