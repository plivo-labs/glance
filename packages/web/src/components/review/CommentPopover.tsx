import { MessageSquarePlus, Sparkles, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Anchor, PopoverState } from '@/lib/commentPopover'
import type { DOMRectLike } from '@/lib/parseIntent'
import type { MentionUser } from '@/lib/mentions'
import { ApiError } from '@/lib/api'
import { Composer } from '@/components/review/Composer'
import { Button } from '@/components/ui/button'

// Streamdown is ~135KB gz — lazy, so the viewer route stays lean and only opening the ask panel
// pays for it. Suspense falls back to the raw markdown text, so tokens are never invisible while
// the chunk loads.
const Streamdown = lazy(() => import('streamdown').then((m) => ({ default: m.Streamdown })))

// In-page comment affordance: a chip pinned to the selection, and the popover its click opens.
// Pure rendering of the A1 reducer's state (lib/commentPopover) — every transition is the parent's.
//
// MOUNT POINT IS LOAD-BEARING: both are absolutely positioned inside the SAME wrapper div that
// holds the iframe (viewer.tsx's `relative h-full w-full`). The iframe fills that wrapper, so the
// rect it reports in ITS viewport coords is already this element's coordinate space — 1:1 px, no
// scale math, no getBoundingClientRect of the iframe. Mounting anywhere else would reintroduce all
// three.
const GAP = 8
const below = (r: DOMRectLike): React.CSSProperties => ({ top: r.top + r.height + GAP, left: r.left })

// The ask panel's approximate max height (quote + textarea + a full answer scroller) — the flip
// decision below compares this against the space actually available, not the panel's live height,
// so a growing answer can never flip the side it already committed to.
const ASK_PANEL_MAX = 340

export function CommentPopover({
  chip,
  composer,
  ask,
  onActivate,
  onAskActivate,
  onDismiss,
  onSubmit,
  onSubmitVoice,
  onAsk,
  loadMentions,
  onDirtyChange,
}: {
  chip: Anchor | null
  composer: PopoverState['composer']
  ask: PopoverState['ask']
  onActivate: () => void
  onAskActivate: () => void
  // Escape / Cancel — the parent's 'dismiss'.
  onDismiss: () => void
  onSubmit: (body: string, mentions: string[]) => void | Promise<void>
  onSubmitVoice: (blob: Blob) => void | Promise<void>
  // Streams one answer. Rejects with ApiError (or whatever the fetch throws) on failure; the panel
  // owns turning that into the error state and a Retry.
  onAsk: (question: string, anchor: Anchor, onToken: (text: string) => void, signal: AbortSignal) => Promise<void>
  loadMentions?: () => Promise<MentionUser[]>
  // Whether the draft has text, reported up because `dirty` is an INPUT to the reducer (a typed
  // draft survives an incidental re-selection). The draft itself stays in the Composer/ask panel.
  onDirtyChange?: (dirty: boolean) => void
}) {
  return (
    <>
      {chip && (
        // A single positioned wrapper, not two — the two buttons are one toolbar pinned to one
        // rect, and neither owns the coordinate on its own.
        <div className="absolute z-20 flex items-center gap-1.5" style={below(chip.rect)}>
          <button
            type="button"
            aria-label="Comment on selection"
            onClick={onActivate}
            className="inline-flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 font-medium text-popover-foreground text-xs shadow-md hover:bg-accent"
          >
            <MessageSquarePlus className="size-3.5" />
            Comment
            {/* The chip is the ONLY place the C binding is discoverable — it lives in the iframe,
                so it appears in no menu and no palette (#117). Same keycap treatment as AppShell's
                ⌘K. Hidden on small screens for the same reason that one is: no keyboard, no hint.
                The button's aria-label already replaces its content, so this is never announced. */}
            <kbd className="hidden rounded border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline">
              C
            </kbd>
          </button>
          <button
            type="button"
            aria-label="Ask AI about selection"
            onClick={onAskActivate}
            className="inline-flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 font-medium text-popover-foreground text-xs shadow-md hover:bg-accent"
          >
            Ask
            <Sparkles className="size-3.5" />
            {/* Mirrors the C keycap above — same discoverability gap (the A binding lives in the
                iframe too), same small-screen hiding, same aria-label override. */}
            <kbd className="hidden rounded border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline">
              A
            </kbd>
          </button>
        </div>
      )}
      {composer && (
        <div
          // A new composer id is a new composer: remounting drops the previous draft, which is what
          // the reducer means when a click on the chip mints a fresh one over an open (even dirty) box.
          key={composer.id}
          style={below(composer.anchor.rect)}
          className="absolute z-30 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
          // Escape closes the popover — but ONLY once the Composer hasn't already claimed it for its
          // open mention menu (it preventDefaults there). Menu first, popover on the next press.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) onDismiss()
          }}
        >
          <p className="mb-2 line-clamp-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">
            “{composer.anchor.quote}”
          </p>
          <Composer
            autoFocus
            placeholder="Add a comment…"
            submitLabel="Comment"
            loadMentions={loadMentions}
            onSubmit={onSubmit}
            onSubmitVoice={onSubmitVoice}
            onCancel={onDismiss}
            onDirtyChange={onDirtyChange}
          />
        </div>
      )}
      {ask && (
        // Same remount-on-id contract as the composer above: a fresh ask id is a fresh question.
        <AskPanel key={ask.id} ask={ask} onAsk={onAsk} onDismiss={onDismiss} onDirtyChange={onDirtyChange} />
      )}
    </>
  )
}

// Opening the panel asks this immediately — the user reached for "Ask" wanting the selection
// explained, so the first answer starts streaming with zero typing. Follow-ups are typed.
const DEFAULT_QUESTION = 'Explain this'

// One question→answer exchange. Each is an independent API call — the server holds no
// conversation; the selection (quote + blockText) is the context every turn re-sends.
type Turn = { q: string; answer: string; status: 'streaming' | 'done' | 'error'; error?: string }

// The "Ask AI about the selection" panel: auto-asks DEFAULT_QUESTION on open, then takes typed
// follow-ups, keeping every turn on screen. Answers render through Streamdown WHILE streaming —
// it parses incomplete markdown per chunk (an unclosed ** or ``` renders sensibly mid-stream) and
// sanitizes by default, which is why the marked-based parse-once path could go.
// Not reused anywhere else, so it stays private to this file rather than becoming its own module.
function AskPanel({
  ask,
  onAsk,
  onDismiss,
  onDirtyChange,
}: {
  ask: NonNullable<PopoverState['ask']>
  onAsk: (question: string, anchor: Anchor, onToken: (text: string) => void, signal: AbortSignal) => Promise<void>
  onDismiss: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Re-armed whenever the user scrolls back to the bottom — disarmed the moment they scroll up, so
  // reading an earlier part of a growing answer isn't yanked back down on the next token.
  const stickToBottom = useRef(true)

  // Which side of the anchor the panel sits on, decided ONCE at open — never mid-stream, or a
  // growing answer would flip the panel out from under the user's cursor. Starts 'below' (today's
  // placement) and the layout effect corrects it, synchronously before paint, if the space below
  // the anchor can't fit the panel's max height against the wrapper div's height (see the MOUNT
  // POINT comment above: that wrapper is this panel's offsetParent, and the rect is already in its
  // coordinate space).
  const [placement, setPlacement] = useState<{ side: 'below' | 'above'; containerHeight: number }>({
    side: 'below',
    containerHeight: 0,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once, on mount only — ask.anchor.rect is stable for this panel's whole life (a new ask id remounts it, see the `key` at the call site).
  useLayoutEffect(() => {
    const container = panelRef.current?.offsetParent
    const containerHeight = container instanceof HTMLElement ? container.clientHeight : 0
    const spaceBelow = containerHeight - (ask.anchor.rect.top + ask.anchor.rect.height + GAP)
    setPlacement({ side: spaceBelow < ASK_PANEL_MAX ? 'above' : 'below', containerHeight })
  }, [])

  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const lastTurn = turns[turns.length - 1]
  const streaming = lastTurn?.status === 'streaming'

  // Dirty from mount to unmount: the auto-asked first turn means there is ALWAYS an answer (or a
  // stream) on screen, so per the reducer's contract click-away never closes this panel — only the
  // ✕, Escape, or opening the comment composer do.
  useEffect(() => {
    onDirtyChange?.(true)
    return () => onDirtyChange?.(false)
  }, [onDirtyChange])

  // Abort an in-flight stream on unmount: dismiss (Escape/✕) unmounts this panel, and a stream
  // nobody is listening to anymore should stop being fetched, not just stop being rendered.
  useEffect(() => () => abortRef.current?.abort(), [])

  const patchLast = (patch: Partial<Turn>) =>
    setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...patch } : t)))

  async function run(q: string) {
    setTurns((ts) => [...ts, { q, answer: '', status: 'streaming' }])
    stickToBottom.current = true
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await onAsk(
        q,
        ask.anchor,
        (t) =>
          setTurns((ts) => ts.map((turn, i) => (i === ts.length - 1 ? { ...turn, answer: turn.answer + t } : turn))),
        controller.signal,
      )
      patchLast({ status: 'done' })
      textareaRef.current?.focus() // the follow-up box is the natural next stop
    } catch (err) {
      if (controller.signal.aborted) return // torn down on unmount — nothing left to show
      patchLast({ status: 'error', error: err instanceof ApiError ? err.message : 'Something went wrong' })
    } finally {
      abortRef.current = null
    }
  }

  // The zero-typing open: asking IS the intent behind pressing Ask, so the default question fires
  // immediately. Mount-only — a new selection mints a new ask id, which remounts this panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once, on mount.
  useEffect(() => {
    void run(DEFAULT_QUESTION)
  }, [])

  // Stick the turn list to its bottom while an answer streams (see stickToBottom above).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `turns` drives re-runs, not the body.
  useEffect(() => {
    if (!streaming || !stickToBottom.current) return
    const el = answerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, streaming])

  function submit() {
    const q = question.trim()
    if (!q || streaming) return
    setQuestion('')
    void run(q)
  }

  /** Re-run the errored turn's question, replacing it — a dead turn is not history worth keeping. */
  function retry() {
    const q = lastTurn?.q
    if (!q || streaming) return
    setTurns((ts) => ts.slice(0, -1))
    void run(q)
  }

  const style =
    placement.side === 'below'
      ? below(ask.anchor.rect)
      : { bottom: placement.containerHeight - ask.anchor.rect.top + GAP, left: ask.anchor.rect.left }

  return (
    <div
      ref={panelRef}
      style={style}
      className="absolute z-30 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDismiss()
      }}
    >
      <div className="mb-2 flex items-start gap-2">
        <p className="line-clamp-2 flex-1 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">
          “{ask.anchor.quote}”
        </p>
        {/* The one dismissal that needs no focus and no keyboard: once an answer is on screen the
            reducer treats the panel as dirty (click-away keeps it, by design), so without this the
            only ways out are Escape — which needs focus inside the panel — or a click into the
            iframe. The Composer never needed it (its Cancel button plays this role). */}
        <button
          type="button"
          aria-label="Close"
          onClick={onDismiss}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {/* Every turn stays on screen — a follow-up reads against the answer it follows. One shared
          scroll box so the whole exchange caps at the panel max, not each answer separately. */}
      <div
        ref={answerRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4
        }}
        style={{ maxHeight: 'min(45vh, 320px)' }}
        className="overflow-y-auto rounded-md border bg-muted/30 px-3 py-2"
      >
        {turns.map((turn, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only (an errored one is replaced in place); index identity is exactly their identity.
          <div key={i} className={i > 0 ? 'mt-2 border-border/60 border-t pt-2' : undefined}>
            <p className="mb-1 font-medium text-[11px] text-muted-foreground">{turn.q}</p>
            {turn.status === 'error' ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-destructive text-xs">{turn.error}</span>
                <Button type="button" size="sm" variant="outline" onClick={retry}>
                  Retry
                </Button>
              </div>
            ) : turn.answer ? (
              <Suspense fallback={<p className="whitespace-pre-wrap text-sm">{turn.answer}</p>}>
                <Streamdown className="text-sm">{turn.answer}</Streamdown>
              </Suspense>
            ) : (
              <p className="text-muted-foreground text-xs">Thinking…</p>
            )}
          </div>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        // The panel is opened by an explicit user action, and the first question is auto-asked —
        // the follow-up box is where the keyboard belongs next.
        // biome-ignore lint/a11y/noAutofocus: opened by explicit user action
        autoFocus
        value={question}
        // readOnly, NOT disabled, while streaming: a disabled textarea drops focus, and with focus
        // outside the panel its Escape handler above never fires.
        readOnly={streaming}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Ask a follow-up…"
        rows={1}
        className="mt-2 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 read-only:opacity-70"
      />
      <p className="mt-1 text-right text-[10px] text-muted-foreground">AI · not saved</p>
    </div>
  )
}
