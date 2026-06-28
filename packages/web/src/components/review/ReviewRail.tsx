import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { Thread, ThreadStatus } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/review/Composer'
import { ThreadCard } from '@/components/review/ThreadCard'

type Pending = { quote: string; prefix: string; suffix: string }

const byUpdatedDesc = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

// Persistent right-rail for review mode: filter (open/resolved), a quote-prefilled composer on
// select, the thread list, and an Outdated group for anchors that no longer resolve.
export function ReviewRail({
  site,
  me,
  threads,
  composing,
  onCancelComposer,
  onCreate,
  onChanged,
  onFocusAnchor,
  onExit,
}: {
  site: ViewerSite
  me: Me | null
  threads: Thread[]
  composing: Pending | null
  onCancelComposer: () => void
  onCreate: (body: string) => void | Promise<void>
  onChanged: () => void
  onFocusAnchor: (quote: string) => void
  onExit: () => void
}) {
  const [filter, setFilter] = useState<ThreadStatus>('open')

  const { active, outdated } = useMemo(() => {
    const outdated = threads.filter((t) => t.anchorStatus === 'orphaned').sort(byUpdatedDesc)
    const active = threads.filter((t) => t.anchorStatus !== 'orphaned' && t.status === filter).sort(byUpdatedDesc)
    return { active, outdated }
  }, [threads, filter])

  return (
    <aside className="flex max-h-[55vh] w-full shrink-0 flex-col border-t bg-background md:max-h-none md:h-full md:w-[360px] md:border-t-0 md:border-l">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold text-sm">Comments</h2>
        <Button variant="ghost" size="icon" onClick={onExit} aria-label="Exit review mode">
          <X className="size-4" />
        </Button>
      </header>

      {composing && (
        <div className="border-b bg-muted/40 p-3">
          <p className="mb-2 line-clamp-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">
            “{composing.quote}”
          </p>
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
            {filter === 'open' ? 'Select text in the page to start a comment.' : 'No resolved threads.'}
          </p>
        )}
        {active.map((t) => (
          <ThreadCard key={t.id} site={site} me={me} thread={t} onChanged={onChanged} onFocusAnchor={onFocusAnchor} />
        ))}

        {outdated.length > 0 && (
          <div className="mt-2 flex flex-col gap-3">
            <p className="px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">Outdated</p>
            {outdated.map((t) => (
              <ThreadCard key={t.id} site={site} me={me} thread={t} onChanged={onChanged} onFocusAnchor={onFocusAnchor} />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
