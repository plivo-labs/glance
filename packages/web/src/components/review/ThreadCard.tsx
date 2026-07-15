import { useState } from 'react'
import { Check, Mic, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { comments, type Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { AudioPlayer } from '@/components/audio/AudioPlayer'
import { AnchorChip } from '@/components/review/AnchorChip'
import { Composer } from '@/components/review/Composer'
import { Badge } from '@/components/ui/badge'

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
  onFocusAnchor: (thread: Thread) => void
}) {
  const [replying, setReplying] = useState(false)
  const canModerate = site.isOwner || me?.role === 'superadmin'

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn()
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed')
    }
  }

  return (
    // id lets a notification deep-link scroll this card into view (viewer S11).
    <div id={`thread-${thread.id}`} className="rounded-lg border bg-card p-3 text-card-foreground">
      <div className="mb-2 flex items-start justify-between gap-2">
        {thread.anchorType === 'element' && thread.anchor ? (
          <button type="button" onClick={() => onFocusAnchor(thread)} className="text-left hover:opacity-80">
            <AnchorChip tag={thread.anchor.tag} preview={thread.anchor.preview} />
          </button>
        ) : thread.quote ? (
          <button
            type="button"
            onClick={() => onFocusAnchor(thread)}
            className="line-clamp-2 border-primary/40 border-l-2 pl-2 text-left text-muted-foreground text-xs italic hover:text-foreground"
          >
            “{thread.quote}”
          </button>
        ) : (
          <span className="text-muted-foreground text-xs">Page comment</span>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {thread.comments.map((c) => (
          <li key={c.id} className="group text-sm">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">{c.authorId === me?.id ? 'You' : (c.author ?? 'Reviewer')}</span>
              <span>{fmt(c.createdAt)}</span>
              {c.hasAudio && !c.deleted && (
                <Badge variant="secondary" className="gap-1 px-1.5 py-0 font-medium">
                  <Mic className="size-2.5" />
                  Voice
                </Badge>
              )}
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
            {/* Voice comment: the transcript above stays always-visible; the recording plays from
                the auth-gated audio route (deleted comments lose hasAudio, so they never reach here). */}
            {c.hasAudio && !c.deleted && (
              <div className="mt-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5">
                <AudioPlayer compact src={`/api/sites/${site.spaceSlug}/${site.siteSlug}/comments/audio/${c.id}`} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {replying ? (
        <div className="mt-3">
          <Composer
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            loadMentions={() => comments.mentionable(site)}
            onCancel={() => setReplying(false)}
            onSubmit={async (body, mentions) => {
              await run(() => comments.reply(site, thread.id, body, mentions))
              setReplying(false)
            }}
            onSubmitVoice={async (blob) => {
              await run(() => comments.replyVoice(site, thread.id, blob))
              setReplying(false)
            }}
          />
        </div>
      ) : (
        // Low-emphasis text actions — kept quiet so the thread, not its controls, reads first.
        // Right-aligned so the transcript/reply reads first and the controls sit out of the way.
        <div className="mt-2 flex items-center justify-end gap-4">
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="text-muted-foreground text-xs transition-colors hover:text-foreground"
          >
            Reply
          </button>
          {canModerate &&
            (thread.status === 'open' ? (
              <button
                type="button"
                onClick={() => run(() => comments.setStatus(site, thread.id, 'resolved'))}
                className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
              >
                <Check className="size-3" />
                Resolve
              </button>
            ) : (
              <button
                type="button"
                onClick={() => run(() => comments.setStatus(site, thread.id, 'open'))}
                className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
              >
                <RotateCcw className="size-3" />
                Reopen
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
