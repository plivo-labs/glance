import { useState } from 'react'
import { Check, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { comments, type Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/review/Composer'

// Anchor-status badges. anchored is the silent default (no badge); the rest signal that the
// underlying text drifted and a human should glance at it.
const STATUS_LABEL: Record<string, string> = { shifted: 'Moved', suggested: 'Review', orphaned: 'Outdated' }

export function ThreadCard({
  site,
  me,
  thread,
  onChanged,
  onFocusAnchor,
}: {
  site: ViewerSite
  me: Me | null
  thread: Thread
  onChanged: () => void
  onFocusAnchor: (quote: string) => void
}) {
  const [replying, setReplying] = useState(false)
  const canModerate = site.isOwner || me?.role === 'superadmin'
  const badge = STATUS_LABEL[thread.anchorStatus]

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn()
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed')
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3 text-card-foreground">
      <div className="mb-2 flex items-start justify-between gap-2">
        {thread.quote ? (
          <button
            type="button"
            onClick={() => onFocusAnchor(thread.quote as string)}
            className="line-clamp-2 border-primary/40 border-l-2 pl-2 text-left text-muted-foreground text-xs italic hover:text-foreground"
          >
            “{thread.quote}”
          </button>
        ) : (
          <span className="text-muted-foreground text-xs">Page comment</span>
        )}
        {badge && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {badge}
          </Badge>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {thread.comments.map((c) => (
          <li key={c.id} className="group text-sm">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">{c.authorId === me?.id ? 'You' : 'Reviewer'}</span>
              <span>{fmt(c.createdAt)}</span>
              {c.editedAt && !c.deleted && <span>(edited)</span>}
              {!c.deleted && (c.authorId === me?.id || canModerate) && (
                <button
                  type="button"
                  onClick={() => run(() => comments.remove(site, thread.id, c.id))}
                  className="ml-auto opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Delete comment"
                >
                  <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              )}
            </div>
            <p className={c.deleted ? 'text-muted-foreground italic' : 'whitespace-pre-wrap'}>
              {c.deleted ? 'comment deleted' : c.body}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        {replying ? (
          <Composer
            className="w-full"
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await run(() => comments.reply(site, thread.id, body))
              setReplying(false)
            }}
          />
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setReplying(true)}>
              Reply
            </Button>
            {canModerate &&
              (thread.status === 'open' ? (
                <Button variant="ghost" size="sm" onClick={() => run(() => comments.setStatus(site, thread.id, 'resolved'))}>
                  <Check className="size-3.5" />
                  Resolve
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => run(() => comments.setStatus(site, thread.id, 'open'))}>
                  <RotateCcw className="size-3.5" />
                  Reopen
                </Button>
              ))}
          </>
        )}
      </div>
    </div>
  )
}

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
