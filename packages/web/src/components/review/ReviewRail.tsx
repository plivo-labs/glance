import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { PendingAnchor, Thread, ThreadStatus } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AnchorChip } from '@/components/review/AnchorChip'
import { Composer } from '@/components/review/Composer'
import { ThreadCard } from '@/components/review/ThreadCard'

export type ReviewMode = 'read' | 'annotate'

const byUpdatedDesc = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

// Persistent right-rail for review mode: a Read·Annotate toggle, filter (open/resolved), an
// anchor-prefilled composer on select/pinpoint, and the thread list.
export function ReviewRail({
  site,
  me,
  threads,
  composing,
  mode,
  onMode,
  onCancelComposer,
  onCreate,
  onChanged,
  onFocusAnchor,
  onExit,
}: {
  site: ViewerSite
  me: Me | null
  threads: Thread[]
  composing: PendingAnchor | null
  mode: ReviewMode
  onMode: (mode: ReviewMode) => void
  onCancelComposer: () => void
  onCreate: (body: string) => void | Promise<void>
  onChanged: () => void
  onFocusAnchor: (thread: Thread) => void
  onExit: () => void
}) {
  const [filter, setFilter] = useState<ThreadStatus>('open')

  const active = useMemo(() => threads.filter((t) => t.status === filter).sort(byUpdatedDesc), [threads, filter])

  return (
    <aside className="flex max-h-[55vh] w-full shrink-0 flex-col border-t bg-background md:max-h-none md:h-full md:w-[360px] md:border-t-0 md:border-l">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-semibold text-sm">Comments</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-muted p-0.5">
            {(['read', 'annotate'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onMode(m)}
                aria-pressed={mode === m}
                className={cn(
                  'rounded px-2 py-0.5 text-xs capitalize transition-colors',
                  mode === m ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" onClick={onExit} aria-label="Exit review mode">
            <X className="size-4" />
          </Button>
        </div>
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
          <Composer autoFocus placeholder="Add a comment…" submitLabel="Comment" onSubmit={onCreate} onCancel={onCancelComposer} />
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
