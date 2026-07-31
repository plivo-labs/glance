import { useState } from 'react'
import { Check, FileText, Mic, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { comments, type CommentItem, type CommentReaction, type Thread } from '@/lib/comments'
import type { Me, ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AudioPlayer } from '@/components/audio/AudioPlayer'
import { UserAvatar } from '@/components/UserAvatar'
import { AnchorChip } from '@/components/review/AnchorChip'
import { Composer } from '@/components/review/Composer'
import { EmojiPicker } from '@/components/review/EmojiPicker'
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
  // `pushed` says whether the room fans THIS change back to us over the comments socket (S9): a
  // reply is pushed, resolve/reopen/delete are not (ruled decision 5). The caller needs the
  // distinction to know whether its refetch is the only thing that will ever show the change.
  onChanged: (change: { pushed: boolean }) => void
  // Scroll only: a click jumps the iframe to the anchor. It doesn't light anything — every anchor
  // on the page is already highlighted for as long as the rail is open.
  onFocusAnchor: (thread: Thread) => void
}) {
  const [replying, setReplying] = useState(false)
  // Reaction lists the server has since re-stated, by comment id. The toggle endpoints answer with
  // the comment's FRESH list, so a successful toggle is already the truth — refetching the thread
  // (what onChanged does) would spend a request to learn what the response just said.
  //
  // `from` is the props array the override was computed against, and it is what EXPIRES the entry:
  // a later `comments.list` hands this comment a brand-new array, the identities stop matching, and
  // the server's list takes over again. Without that, the first toggle would freeze the comment —
  // nothing polls, so every reaction anyone else added afterwards would stay invisible until a
  // reload.
  const [reacted, setReacted] = useState(new Map<string, { from: CommentReaction[]; value: CommentReaction[] }>())
  const canModerate = site.isOwner || me?.role === 'superadmin'

  const toastError = (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Action failed')

  // RETHROWS after toasting: a reply that resolves on failure lets the caller close the composer
  // and Composer clear the draft, so the typed reply (or the recording) is gone with nothing to
  // retry. Callers that close UI on success must therefore await this and let a rejection stop them.
  async function run(fn: () => Promise<unknown>, pushed: boolean) {
    try {
      await fn()
    } catch (err) {
      toastError(err)
      throw err
    }
    onChanged({ pushed })
  }

  /** What to render for a comment: the override, but only while it still describes the list it was
   *  derived from. A newer props array means a newer answer than the one held here. */
  const reactionsOf = (c: CommentItem) => {
    const held = reacted.get(c.id)
    return held?.from === c.reactions ? held.value : c.reactions
  }

  // Deliberately NOT `run`: no onChanged, and nothing is written optimistically — the chips move
  // only once the server has answered, so a rejection leaves them telling the truth they already
  // told (including the server's own caps, which are its rules to enforce, not ours to mirror).
  const toggle = (c: CommentItem, emoji: string, mine: boolean) => () => {
    const call = mine ? comments.unreact : comments.react
    // `c` is the comment as of the click. If a refetch lands while this is in flight, `c.reactions`
    // is no longer the comment's array and the override is stale on arrival — so it is ignored and
    // the newer server list stands, which is the right way round to lose a race.
    void call(site, thread.id, c.id, emoji)
      .then((fresh) => setReacted((m) => new Map(m).set(c.id, { from: c.reactions, value: fresh })))
      .catch(toastError)
  }

  // onClick handler for the button actions: they have no draft to protect and their failure is
  // already a toast, so the rejection `run` raises is deliberately dropped rather than left unhandled.
  // Every button action here (delete, resolve, reopen) is one the room does NOT push back.
  const act = (fn: () => Promise<unknown>) => () => void run(fn, false).catch(() => {})

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
          // No quote and no element: a PAGE thread, about the file as a whole. It paints nothing on
          // the page (paintAnchors, lib/comments.ts) and has nothing to focus, so this is a static
          // marker, not a button — but it's chip-weight like AnchorChip so the card doesn't read as
          // an anchorless orphan beside anchored ones (#112).
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground text-xs">
            <FileText className="size-3" />
            Page
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {thread.comments.map((c) => (
          <li key={c.id} className="group text-sm">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <UserAvatar userId={c.authorId} name={c.author} className="size-5" fallbackClassName="text-[0.6rem]" />
              <span className="font-medium text-foreground">{c.authorId === me?.id ? 'You' : (c.author ?? 'Reviewer')}</span>
              <span>{fmt(c.createdAt)}</span>
              {c.hasAudio && !c.deleted && (
                <Badge variant="secondary" className="gap-1 px-1.5 py-0 font-medium">
                  <Mic className="size-2.5" />
                  Voice
                </Badge>
              )}
              {c.editedAt && !c.deleted && <span>(edited)</span>}
              {!c.deleted && c.authorId === me?.id && (
                <button
                  type="button"
                  onClick={act(() => comments.remove(site, thread.id, c.id))}
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
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {reactionsOf(c).map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  // A toggle, so it announces as one: pressed IS `mine`, which is the same fact the
                  // filled chip shows sighted users.
                  aria-pressed={r.mine}
                  aria-label={`${r.emoji} ${r.count}`}
                  onClick={toggle(c, r.emoji, r.mine)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors',
                    r.mine
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-transparent bg-muted text-muted-foreground hover:bg-muted/70',
                  )}
                >
                  {r.emoji}
                  <span className="tabular-nums">{r.count}</span>
                </button>
              ))}
              {/* No add trigger on a soft-deleted comment: the server 404s a new reaction there, so
                  offering one would only produce a toast. The chips it already carries stay. */}
              {!c.deleted && (
                <EmojiPicker
                  label="Add reaction"
                  className="size-6 rounded-full border-dashed px-0 text-muted-foreground"
                  onPick={(emoji) => toggle(c, emoji, false)()}
                />
              )}
            </div>
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
              await run(() => comments.reply(site, thread.id, body, mentions), true)
              setReplying(false)
            }}
            onSubmitVoice={async (blob) => {
              await run(() => comments.replyVoice(site, thread.id, blob), true)
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
                onClick={act(() => comments.setStatus(site, thread.id, 'resolved'))}
                className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
              >
                <Check className="size-3" />
                Resolve
              </button>
            ) : (
              <button
                type="button"
                onClick={act(() => comments.setStatus(site, thread.id, 'open'))}
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
