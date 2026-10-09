import { Clock, Mic, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { EmojiPicker } from '@/components/review/EmojiPicker'
import { UserAvatar } from '@/components/UserAvatar'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import { formatTimestamp } from '@/lib/audio'
import { type MentionUser, filterMentions, insertMention, mentionLabel, mentionQuery } from '@/lib/mentions'
import { cn } from '@/lib/utils'

/** One key of the submit button's shortcut hint. Sized to sit inside a `size-sm` Button without
 *  changing its height — `py-px`, not a padding that would grow the row. */
const KEYCAP =
  'rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 py-px font-mono text-[10px] leading-none text-primary-foreground/90'

// Shared composer for a new thread or a flat reply. Text and voice are alternative submit paths:
// typing submits trimmed non-empty bodies via onSubmit (clears on success); the mic records a clip
// that submits via onSubmitVoice. When `loadMentions` is set, an `@` opens an autocomplete of
// site-mentionable users; the chosen ids ride along to onSubmit. An emoji picker sits in the action
// row and inserts at the caret, the same way a mention does. Controlled locally.
export function Composer({
  placeholder,
  submitLabel,
  initialBody,
  onSubmit,
  onSubmitVoice,
  onCancel,
  autoFocus,
  focusOn,
  className,
  timestampButton,
  loadMentions,
  onDirtyChange,
  onTyping,
  onTypingStop,
}: {
  placeholder: string
  submitLabel: string
  // Seed the draft (editing an existing comment). Mount-time only — this is an uncontrolled draft.
  initialBody?: string
  onSubmit: (body: string, mentions: string[]) => void | Promise<void>
  // When set, the composer shows a mic that records a clip and submits it here (voice comment).
  onSubmitVoice?: (blob: Blob) => void | Promise<void>
  onCancel?: () => void
  autoFocus?: boolean
  // Refocus the textarea whenever this value changes identity. `autoFocus` only fires on mount, so
  // a click that re-anchors an already-open composer would leave focus in the iframe — pass the
  // pending anchor here so every select/pinpoint puts the caret back in the box.
  focusOn?: unknown
  className?: string
  // Audio view only: inserts a `[m:ss] ` prefix for the player's current position. `getPrefix`
  // is called at click time (not render time) so it always reflects the latest playback position.
  timestampButton?: { label: string; getPrefix: () => string }
  // Lazily fetch the users this composer may @-mention (called once, on the first `@`). Absent →
  // no mention UI (e.g. contexts with no site scope). Text-only feature; the voice path ignores it.
  loadMentions?: () => Promise<MentionUser[]>
  // Report whether the draft has text — additive, and the ONLY thing that leaves this component:
  // the popover reducer needs `dirty` as an input (it decides whether a new selection may re-anchor
  // an open composer), while the draft itself stays owned here.
  onDirtyChange?: (dirty: boolean) => void
  // Reported on EVERY keystroke — the rate cap that keeps this off the Durable Object's bill lives
  // in commentStream, so a second copy of it here would only drift. Text path only: a voice clip
  // isn't typing.
  onTyping?: () => void
  // The draft stopped: blur, or a submit that actually landed. A rejected write leaves the user
  // sitting on their text, still typing — same rule the draft itself follows.
  onTypingStop?: () => void
}) {
  const [body, setBody] = useState(initialBody ?? '')
  const [busy, setBusy] = useState(false)
  const rec = useMediaRecorder()
  const trimmed = body.trim()
  // While recording/paused (or holding a finished clip) the voice strip takes over the composer —
  // text and voice are one-or-the-other for a single submit.
  const recording = rec.state === 'recording' || rec.state === 'paused'
  const recorded = rec.state === 'stopped'

  // An effect, not a call inside onChange: every path that rewrites the body (mention insert,
  // timestamp prefix, the clear after a successful submit) then reports through this one place.
  const dirty = trimmed.length > 0
  useEffect(() => {
    onDirtyChange?.(dirty)
    // A composer that unmounts has no draft, and nothing else will ever say so: a successful save
    // closes this component in the SAME commit that clears the body, so the trailing `false` would
    // never be reported and the parent would keep guarding against a draft that is gone.
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Caret to restore after a mention insertion re-renders the textarea (React won't preserve it).
  const pendingCaret = useRef<number | null>(null)
  useEffect(() => {
    if (focusOn !== undefined) textareaRef.current?.focus()
  }, [focusOn])
  useEffect(() => {
    if (pendingCaret.current !== null && textareaRef.current) {
      const el = textareaRef.current
      el.focus()
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  })

  // --- @-mention autocomplete state (inert unless loadMentions is set) ---
  const [users, setUsers] = useState<MentionUser[] | null>(null)
  // The chosen mentions, by id → label; kept to (a) send ids on submit and (b) drop any whose
  // `@Label` text the user has since deleted from the body.
  const chosen = useRef(new Map<string, string>())
  const [menu, setMenu] = useState<{ start: number; query: string } | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const candidates = menu && users ? filterMentions(users, menu.query) : []
  const menuOpen = candidates.length > 0

  // Recompute the mention menu from the textarea's current value + caret. Loads the user list on the
  // first `@` seen. No-op when mentions aren't enabled.
  function syncMenu(value: string, caret: number) {
    if (!loadMentions) return
    const active = mentionQuery(value, caret)
    if (!active) {
      setMenu(null)
      return
    }
    if (users === null) void loadMentions().then(setUsers, () => setUsers([]))
    setMenu(active)
    setActiveIdx(0)
  }

  function onBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setBody(e.target.value)
    syncMenu(e.target.value, e.target.selectionStart)
    onTyping?.()
  }

  // Same insert-at-the-caret contract as a mention, minus the token to replace: the picker is a
  // click away from the textarea, so the draft the user was mid-sentence in must not get an emoji
  // stapled to its end.
  function insertEmoji(emoji: string) {
    const el = textareaRef.current
    const caret = el ? el.selectionStart : body.length
    setBody(body.slice(0, caret) + emoji + body.slice(caret))
    pendingCaret.current = caret + emoji.length
  }

  function pickMention(user: MentionUser) {
    const el = textareaRef.current
    const caret = el ? el.selectionStart : body.length
    const next = insertMention(body, caret, user)
    chosen.current.set(user.id, mentionLabel(user))
    setBody(next.text)
    pendingCaret.current = next.caret
    setMenu(null)
  }

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => (i + 1) % candidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => (i - 1 + candidates.length) % candidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickMention(candidates[activeIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
  }

  // Ids to send: only mentions whose `@Label` still appears in the body (deleting the text un-tags).
  function activeMentionIds(text: string): string[] {
    const ids: string[] = []
    for (const [id, label] of chosen.current) if (text.includes(`@${label}`)) ids.push(id)
    return ids
  }

  // The draft is cleared ONLY after onSubmit resolves. A rejection means the comment did not land,
  // so the typed text stays exactly where it is (the submit handler owns telling the user why) —
  // clearing on a failed submit would destroy work with no way back.
  async function submit() {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed, activeMentionIds(trimmed))
      onTypingStop?.()
      setBody('')
      chosen.current.clear()
      setMenu(null)
    } catch {
      /* draft preserved */
    } finally {
      setBusy(false)
    }
  }

  // Same contract as `submit` for the recording: kept on a rejection (it can't be retyped), and the
  // rejection is absorbed here because this is an onClick handler — the submit handler already
  // toasted, so re-raising would only surface as an unhandled rejection.
  async function sendVoice() {
    if (!rec.blob || busy) return
    setBusy(true)
    try {
      await onSubmitVoice?.(rec.blob)
      rec.reset()
    } catch {
      /* recording preserved */
    } finally {
      setBusy(false)
    }
  }

  if (recording || recorded) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center gap-3 rounded-md border border-input bg-muted/40 px-3 py-2">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              rec.state === 'recording' ? 'animate-pulse bg-destructive' : 'bg-muted-foreground',
            )}
          />
          <span className="font-mono text-sm tabular-nums">{formatTimestamp(rec.elapsedMs / 1000)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {recording ? (
              <Button type="button" size="sm" variant="destructive" onClick={rec.stop}>
                <Square className="size-3.5 fill-current" />
                Stop
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={sendVoice} disabled={busy}>
                {submitLabel}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={rec.reset}
              disabled={busy}
              aria-label="Discard recording"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
        {rec.error && <p className="font-medium text-destructive text-sm">{rec.error}</p>}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="relative">
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          value={body}
          onChange={onBodyChange}
          onKeyDown={onTextareaKeyDown}
          // Keep the menu in sync when the caret moves without an edit (click, arrow keys).
          onClick={(e) => syncMenu(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => {
            setMenu(null)
            onTypingStop?.()
          }}
          placeholder={placeholder}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        {menuOpen && (
          <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            {candidates.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  // Commit the pick before the textarea's blur closes the menu.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(u)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                    i === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  )}
                >
                  <UserAvatar userId={u.id} name={u.name} email={u.email} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{mentionLabel(u)}</span>
                    {u.name && <span className="truncate text-muted-foreground text-xs">{u.email}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={cn('flex items-center gap-2', timestampButton ? 'justify-between' : 'justify-end')}>
        {timestampButton && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBody((b) => timestampButton.getPrefix() + b)}
          >
            <Clock className="size-3.5" />
            {timestampButton.label}
          </Button>
        )}
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <EmojiPicker onPick={insertEmoji} disabled={busy} />
          {onSubmitVoice && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void rec.start()}
              aria-label="Record a voice comment"
            >
              <Mic className="size-3.5" />
            </Button>
          )}
          {/* The explicit aria-label is load-bearing, not decoration: the keycap below is button
              CONTENT, so without it the accessible name becomes "Comment ⌘↵" — for every screen
              reader, and for the 13 `getByRole('button', {name: 'Comment'})` selectors in the
              suite. Labelling the button pins the name to the word, whatever is rendered inside. */}
          <Button type="button" size="sm" aria-label={submitLabel} disabled={!trimmed || busy} onClick={submit}>
            {submitLabel}
            {/* The ⌘/Ctrl+Enter binding on the textarea above, made visible. ONE CAP PER PHYSICAL
                KEY: `⌘↵` sharing a single frame reads as one unfamiliar glyph at 10px rather than
                as two keys you press together. Tinted off the primary fill rather than `bg-muted`
                like AppShell's ⌘K, which sits on an outline button. */}
            <span className="hidden items-center gap-0.5 sm:inline-flex">
              <kbd className={KEYCAP}>⌘</kbd>
              <kbd className={KEYCAP}>↵</kbd>
            </span>
          </Button>
        </div>
      </div>
      {rec.error && <p className="font-medium text-destructive text-sm">{rec.error}</p>}
    </div>
  )
}
