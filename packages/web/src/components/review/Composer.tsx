import { Clock, Mic, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import { formatTimestamp } from '@/lib/audio'
import { type MentionUser, filterMentions, insertMention, mentionLabel, mentionQuery } from '@/lib/mentions'
import { cn } from '@/lib/utils'

// Shared composer for a new thread or a flat reply. Text and voice are alternative submit paths:
// typing submits trimmed non-empty bodies via onSubmit (clears on success); the mic records a clip
// that submits via onSubmitVoice. When `loadMentions` is set, an `@` opens an autocomplete of
// site-mentionable users; the chosen ids ride along to onSubmit. Controlled locally.
export function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onSubmitVoice,
  onCancel,
  autoFocus,
  focusOn,
  className,
  timestampButton,
  loadMentions,
}: {
  placeholder: string
  submitLabel: string
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
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const rec = useMediaRecorder()
  const trimmed = body.trim()
  // While recording/paused (or holding a finished clip) the voice strip takes over the composer —
  // text and voice are one-or-the-other for a single submit.
  const recording = rec.state === 'recording' || rec.state === 'paused'
  const recorded = rec.state === 'stopped'

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

  async function submit() {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed, activeMentionIds(trimmed))
      setBody('')
      chosen.current.clear()
      setMenu(null)
    } finally {
      setBusy(false)
    }
  }

  async function sendVoice() {
    if (!rec.blob || busy) return
    setBusy(true)
    try {
      await onSubmitVoice?.(rec.blob)
      rec.reset()
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
          // biome-ignore lint/a11y/noAutofocus: composer is opened by an explicit user action.
          autoFocus={autoFocus}
          value={body}
          onChange={onBodyChange}
          onKeyDown={onTextareaKeyDown}
          // Keep the menu in sync when the caret moves without an edit (click, arrow keys).
          onClick={(e) => syncMenu(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setMenu(null)}
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
                    'flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm',
                    i === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  )}
                >
                  <span className="font-medium">{mentionLabel(u)}</span>
                  {u.name && <span className="text-muted-foreground text-xs">{u.email}</span>}
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
          <Button type="button" size="sm" disabled={!trimmed || busy} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
      {rec.error && <p className="font-medium text-destructive text-sm">{rec.error}</p>}
    </div>
  )
}
