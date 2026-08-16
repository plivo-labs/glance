import { MessageSquarePlus, Sparkles, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Anchor, PopoverState } from '@/lib/commentPopover'
import type { DOMRectLike } from '@/lib/parseIntent'
import type { MentionUser } from '@/lib/mentions'
import { ApiError } from '@/lib/api'
import { renderMarkdown } from '@/lib/markdown'
import { Composer } from '@/components/review/Composer'
import { Button } from '@/components/ui/button'

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

// Shared by the streaming (plain text) and settled (markdown) renderings of the answer box below,
// so the swap between them is invisible: same border, same prose styles, same scroll box.
const ANSWER_CLASS =
  'mt-2 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-sm [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_li]:my-0.5 [&_p]:my-1.5 [&_strong]:font-semibold [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5'

// The "Ask AI about the selection" panel: a local idle → streaming → done | error state machine.
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
  // Gates the refocus effect below to POST-submit resets only: the initial mount already autofocuses.
  const submittedOnce = useRef(false)

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
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Dirty per the reducer's contract: text typed, a stream in flight, or an answer on screen —
  // false the instant the panel resets to idle or unmounts.
  const dirty = question.trim().length > 0 || status === 'streaming' || status === 'done'
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  // Abort an in-flight stream on unmount: dismiss (Escape/click-away) unmounts this panel, and a
  // stream nobody is listening to anymore should stop being fetched, not just stop being rendered.
  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (submittedOnce.current && status === 'idle') textareaRef.current?.focus()
  }, [status])

  // `answer` is read only via the DOM (scrollHeight), never in the body below — but it's what
  // must re-run this on every token, so it stays in the deps despite that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answer` drives re-runs, not the body.
  useEffect(() => {
    if (status !== 'streaming' || !stickToBottom.current) return
    const el = answerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [answer, status])

  async function run(q: string) {
    setStatus('streaming')
    setAnswer('')
    setError(null)
    stickToBottom.current = true
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await onAsk(q, ask.anchor, (t) => setAnswer((a) => a + t), controller.signal)
      setStatus('done')
    } catch (err) {
      if (controller.signal.aborted) return // torn down on unmount — nothing left to show
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
      setStatus('error')
    } finally {
      abortRef.current = null
    }
  }

  function submit() {
    const q = question.trim()
    // idle only: the textarea stays focusable after submit (readOnly, see below), so Enter still
    // reaches this — on 'done' it must not silently re-run the same question.
    if (!q || status !== 'idle') return
    submittedOnce.current = true
    void run(q)
  }

  function askAnother() {
    setQuestion('')
    setAnswer('')
    setError(null)
    setStatus('idle')
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
      <textarea
        ref={textareaRef}
        // biome-ignore lint/a11y/noAutofocus: panel is opened by an explicit user action.
        autoFocus
        value={question}
        // readOnly, NOT disabled: a disabled textarea drops focus, and with focus outside the panel
        // its Escape handler below never fires — the answered panel became undismissable from the
        // keyboard. readOnly locks the text the same way but keeps focus (and Escape) alive.
        readOnly={status !== 'idle'}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Ask about this selection…"
        rows={2}
        className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 read-only:opacity-70"
      />

      {/* Markdown is parsed ONCE, when the answer settles: re-running Marked over the whole buffer
          per token is O(n²) across a long answer, and half-open constructs mid-stream (an unclosed
          ``` fence) render as flickering malformed HTML. While streaming, the raw text pre-wraps —
          also the graceful shape if the model buffers the entire completion into one delta. */}
      {status === 'streaming' && (
        <div
          ref={answerRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4
          }}
          style={{ maxHeight: 'min(45vh, 320px)' }}
          className={`${ANSWER_CLASS} whitespace-pre-wrap`}
        >
          {answer}
        </div>
      )}
      {status === 'done' && (
        <div
          style={{ maxHeight: 'min(45vh, 320px)' }}
          className={ANSWER_CLASS}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: html is escaped by the client-side twin of the api's hardened Marked config (lib/markdown.ts), not passed through
          dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }}
        />
      )}

      {status === 'error' ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <span className="text-destructive text-xs">{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void run(question.trim())}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {status === 'done' ? 'AI · not saved' : 'not saved'}
          </span>
          {status === 'done' ? (
            <Button type="button" size="sm" variant="outline" onClick={askAnother}>
              Ask another
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!question.trim() || status === 'streaming'} onClick={submit}>
              Ask
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
