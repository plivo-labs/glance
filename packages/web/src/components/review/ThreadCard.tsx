import { useState } from 'react'
import { Check, FileText, Mic, Pencil, RotateCcw, Trash2 } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function ThreadCard({
  site,
  me,
  thread,
  onChanged,
  onFocusAnchor,
  typing,
  onTyping,
  onTypingStop,
}: {
  site: ViewerSite
  me: Me | null
  thread: Thread
  // The other direction of `typing`: THIS viewer is composing a reply here. Optional, like `typing`
  // itself — a rail with no socket behind it simply never pings, so no component test needs them.
  onTyping?: () => void
  onTypingStop?: () => void
  // Someone is replying to THIS thread right now (S12), or null/undefined when nobody is. `name` is
  // null when the rail could not match the ping's viewer id to one of this thread's participants —
  // the wire carries no name, so an unrecognised id renders as "Someone" and never as a name the
  // sender chose.
  typing?: { name: string | null } | null
  // `pushed` says whether the room fans THIS change back to us over the comments socket (S9): a
  // reply is pushed, resolve/reopen/delete are not (ruled decision 5). The caller needs the
  // distinction to know whether its refetch is the only thing that will ever show the change.
  onChanged: (change: { pushed: boolean }) => void
  // Scroll only: a click jumps the iframe to the anchor. It doesn't light anything — every anchor
  // on the page is already highlighted for as long as the rail is open.
  onFocusAnchor: (thread: Thread) => void
}) {
  const [replying, setReplying] = useState(false)
  // Comment id under inline edit, or null. One at a time: starting an edit on another message
  // simply moves the composer there — the abandoned draft was never sent, so nothing is lost.
  const [editing, setEditing] = useState<string | null>(null)
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
  // Site owner only — mirrors the API's `canModerate` (routes/comments.ts). A superadmin is NOT a
  // moderator here; showing them the control would render a button the server 403s.
  const canModerate = site.isOwner

  const toastError = (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Action failed')

  // RETHROWS after toasting: a reply that resolves on failure lets the caller close the composer
  // and Composer clear the draft, so the typed reply (or the recording) is gone with nothing to
  // retry. Callers that close UI on success must therefore await this and let a rejection stop them.
  async function run<T>(fn: () => Promise<T>, pushed: boolean) {
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
  // Every button action here (delete, resolve, reopen) is one the room does NOT push back. An
  // await/try-catch (not a `.catch` chain) absorbs it, since `run` already did everything a handler
  // here needs done.
  const act = <T,>(fn: () => Promise<T>) => async () => {
    try {
      await run(fn, false)
    } catch {
      // run() already toasted — nothing left for this onClick handler to do.
    }
  }

  // A thread nobody has replied to yet is a remark, not a conversation, so it does not pay for a
  // permanently mounted reply bar (measured: that bar costs more than the chrome it replaced, and a
  // rail is mostly threads of one). Once a thread HAS replies it is a conversation and keeps it.
  const pinnedReply = thread.comments.length > 1

  return (
    // id lets a notification deep-link scroll this card into view (viewer S11).
    <div id={`thread-${thread.id}`} className="group/card rounded-lg border bg-card p-3 text-card-foreground">
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

        {/* Resolve/Reopen is a THREAD-level action, so it sits in the thread's own chrome rather
            than under the last message. Always visible, never hover-gated: triage is the reason the
            rail is open at all. */}
        {canModerate &&
          (thread.status === 'open' ? (
            <button
              type="button"
              onClick={act(() => comments.setStatus(site, thread.id, 'resolved'))}
              className="-my-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
            >
              <Check className="size-3" />
              Resolve
            </button>
          ) : (
            <button
              type="button"
              onClick={act(() => comments.setStatus(site, thread.id, 'open'))}
              className="-my-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              Reopen
            </button>
          ))}
      </div>

      <ul className="flex flex-col">
        {thread.comments.map((c, i) => {
          // Consecutive messages from one author collapse into a group: only the first carries the
          // avatar/name/date, the rest indent to the same text column. Four "You · 2 Aug" headers on
          // four messages sent a minute apart is the bulk of what made this card read as a form.
          const head = startsGroup(thread.comments[i - 1], c)
          // Still worth a row on a follow-up: both say something about THAT message, not its author.
          const meta = head || (!c.deleted && (c.hasAudio || !!c.editedAt))
          return (
            <li key={c.id} className="group/msg relative rounded-md py-0.5 text-sm hover:bg-muted/40">
              {/* Rest state is empty: opacity, never `hidden`, so the controls stay in the
                  accessibility tree and stay tab-reachable — focus-within brings them up for anyone
                  not using a mouse.
                  Tailwind compiles group-hover under `@media (hover:hover)`, so on a touch device
                  the bar would never appear and the emoji picker (which used to be a permanent chip)
                  would be unreachable. Where there is no hover, it is simply always on — the same
                  deal touch users get today, minus the desktop clutter. */}
              {!c.deleted && (
                <div className="absolute -top-2 right-1 z-10 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100">
                  {/* rounded-sm, not the default `rounded`: the bar's own corner is rounded-md and
                      it holds its buttons 2px in, so a flat 4px child reads as a square in a round
                      box. The scale's next step down is what CONCENTRIC corners want here. */}
                  <EmojiPicker
                    label="Add reaction"
                    variant="ghost"
                    className="size-6 rounded-sm px-0 text-muted-foreground"
                    onPick={(emoji) => toggle(c, emoji, false)()}
                  />
                  {/* Edit is text-only: a voice comment's body is its transcript, and rewriting a
                      transcript out from under its recording would make the two disagree. */}
                  {c.authorId === me?.id && !c.hasAudio && (
                    <button
                      type="button"
                      onClick={() => setEditing(c.id)}
                      className="flex size-6 items-center justify-center rounded-sm hover:bg-muted"
                      aria-label="Edit comment"
                    >
                      <Pencil className="size-3.5 text-muted-foreground" />
                    </button>
                  )}
                  {c.authorId === me?.id && (
                    <button
                      type="button"
                      onClick={act(() => comments.remove(site, thread.id, c.id))}
                      className="flex size-6 items-center justify-center rounded-sm hover:bg-muted"
                      aria-label="Delete comment"
                    >
                      <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  )}
                </div>
              )}

              <div className="grid grid-cols-[20px_1fr] gap-2">
                <div className="pt-0.5">
                  {head ? (
                    <UserAvatar
                      userId={c.authorId}
                      name={c.author}
                      className="size-5"
                      fallbackClassName="text-[0.6rem]"
                    />
                  ) : (
                    // The gutter a grouped message frees up: the time it was sent, on hover, where
                    // the avatar would have been.
                    <span className="block text-center text-[0.6rem] text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100">
                      {fmtTime(c.createdAt)}
                    </span>
                  )}
                </div>

                <div className="min-w-0">
                  {meta && (
                    <div className="flex items-baseline gap-2 text-muted-foreground text-xs">
                      {head && (
                        <>
                          <span className="font-medium text-foreground">
                            {c.authorId === me?.id ? 'You' : (c.author ?? 'Reviewer')}
                          </span>
                          <span>{fmt(c.createdAt)}</span>
                        </>
                      )}
                      {c.hasAudio && !c.deleted && (
                        <Badge variant="secondary" className="gap-1 px-1.5 py-0 font-medium">
                          <Mic className="size-2.5" />
                          Voice
                        </Badge>
                      )}
                      {c.editedAt && !c.deleted && <span>(edited)</span>}
                    </div>
                  )}
                  {editing === c.id && !c.deleted ? (
                    <div className="mt-1">
                      <Composer
                        autoFocus
                        initialBody={c.body ?? ''}
                        placeholder="Edit comment…"
                        submitLabel="Save"
                        onCancel={() => setEditing(null)}
                        onSubmit={async (body) => {
                          // Not pushed (like delete/resolve): the caller's refetch is the only
                          // thing that will ever show the new body.
                          await run(() => comments.edit(site, thread.id, c.id, body), false)
                          setEditing(null)
                        }}
                      />
                    </div>
                  ) : (
                    <p className={c.deleted ? 'text-muted-foreground italic' : 'whitespace-pre-wrap'}>
                      {c.deleted ? 'comment deleted' : c.body}
                    </p>
                  )}
                  {/* Voice comment: the transcript above stays always-visible; the recording plays
                      from the auth-gated audio route (deleted comments lose hasAudio, so they never
                      reach here). */}
                  {c.hasAudio && !c.deleted && (
                    <div className="mt-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5">
                      <AudioPlayer
                        compact
                        src={`/api/sites/${site.spaceSlug}/${site.siteSlug}/comments/audio/${c.id}`}
                      />
                    </div>
                  )}
                  {/* Only when there are chips to show. The add trigger moved into the hover bar, so
                      a comment nobody reacted to now costs nothing here instead of a permanent
                      dashed circle — the single biggest source of dead space on this card. */}
                  {reactionsOf(c).length > 0 && (
                    <TooltipProvider delayDuration={150}>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {reactionsOf(c).map((r) => {
                          // A count alone doesn't say who is behind it. Hover (or focus — radix
                          // opens on both, and points the trigger's aria-describedby at the content,
                          // so the names reach a screen reader too) answers that.
                          const who = reactorList(r)
                          return (
                            <Tooltip key={r.emoji}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  // A toggle, so it announces as one: pressed IS `mine`, which is
                                  // the same fact the filled chip shows sighted users.
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
                              </TooltipTrigger>
                              {/* Names only. The chip under the cursor already shows the emoji, so
                                  "reacted 👍" spent the tooltip's width restating what was asked. */}
                              <TooltipContent className="max-w-56">{who}</TooltipContent>
                            </Tooltip>
                          )
                        })}
                      </div>
                    </TooltipProvider>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {typing && (
        <p className="mt-2 text-muted-foreground text-xs italic">{`${typing.name ?? 'Someone'} is replying…`}</p>
      )}

      {replying ? (
        <div className="mt-3">
          <Composer
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            loadMentions={() => comments.mentionable(site)}
            onTyping={onTyping}
            onTypingStop={onTypingStop}
            onCancel={() => {
              // Closing the composer is as much a stop as blurring it: the draft is gone, so a peer
              // left showing "…is replying" would be waiting on something that no longer exists.
              onTypingStop?.()
              setReplying(false)
            }}
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
        // A chat's message box, collapsed. On a thread that is already a conversation it stays put;
        // on a thread of one it takes no height until the card is hovered or focused.
        //
        // grid-rows 0fr→1fr, NOT `hidden`: the button has to stay in the accessibility tree and stay
        // tab-reachable while collapsed. Tabbing anywhere into the card opens it, so keyboard users
        // never have to hover to find the reply box.
        //
        // :focus-visible, NOT :focus-within: a mouse click parks plain :focus on whatever button was
        // clicked, and under focus-within that pinned the card open after hover-out — until the next
        // mousedown anywhere else blurred it, collapsed this row, and yanked the page up between that
        // click's mousedown and mouseup, so the victim's click never fired. Keyboard focus is
        // :focus-visible; a mouse click is not.
        <div
          className={cn(
            'grid transition-all duration-150',
            pinnedReply
              ? 'mt-2 grid-rows-[1fr]'
              : // The touch clause is not optional: group-hover compiles under `@media (hover:hover)`,
                // so without it a phone would have no way at all to open a reply on a thread of one.
                'grid-rows-[0fr] group-has-[:focus-visible]/card:mt-2 group-has-[:focus-visible]/card:grid-rows-[1fr] group-hover/card:mt-2 group-hover/card:grid-rows-[1fr] [@media(hover:none)]:mt-2 [@media(hover:none)]:grid-rows-[1fr]',
          )}
        >
          <div className="overflow-hidden">
            <button
              type="button"
              // "Reply", not "Reply…": the label names the action, the ellipsis is the placeholder
              // styling of an input this button stands in for.
              aria-label="Reply"
              onClick={() => setReplying(true)}
              className="flex w-full items-center gap-2 rounded-md border bg-background/40 px-2.5 py-1.5 text-left text-muted-foreground text-xs transition-colors hover:border-foreground/20 hover:text-foreground"
            >
              <UserAvatar
                userId={me?.id}
                name={me?.name}
                email={me?.email}
                className="size-4"
                fallbackClassName="text-[0.5rem]"
              />
              Reply…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Who reacted: the viewer first as "You" (the server sends `mine`, never the caller's own name),
 *  then everyone else in reaction order, comma-separated. The whole list, however long — a name
 *  the reader was looking for is no use summarised away. */
export function reactorList(r: CommentReaction): string {
  return (r.mine ? ['You', ...r.names] : r.names).join(', ')
}

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Five minutes: long enough that a burst of messages reads as one turn, short enough that coming
 *  back to a thread later re-states who is speaking and when. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

/** Does this comment open a new group (avatar + name + date), or continue the one above it?
 *  An unparseable date on either side breaks the group rather than guessing — the header is the
 *  safe answer, since it always says who and when. */
function startsGroup(prev: CommentItem | undefined, c: CommentItem): boolean {
  if (!prev || prev.authorId !== c.authorId) return true
  const a = Date.parse(prev.createdAt)
  const b = Date.parse(c.createdAt)
  if (Number.isNaN(a) || Number.isNaN(b)) return true
  return b - a > GROUP_WINDOW_MS
}
