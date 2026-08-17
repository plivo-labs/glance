// Parent-side intent FILTER for messages from the annotate iframe (Step 12).
//
// This is explicitly a shape/size/source filter — NOT a trust or authority guard. Hostile
// uploaded HTML shares the content origin and can forge any message, so passing this filter
// proves nothing about intent. The real guard is the architectural invariant (COMMENTS_PLAN
// constraint 1): an iframe message may only OPEN UI or SUGGEST an anchor; every mutation is
// parent-initiated after an explicit user action, and all anchor resolution is server-side.

import type { TextContext } from '@/lib/comments'

export type SelectIntent = {
  type: 'select'
  quote: string
  context?: TextContext
  rect?: DOMRectLike
  /** The selection's enclosing element's text — extra context sent to the AI on "Ask" (Step 12+).
   *  Clamped like the quote, never rejected: it is a nice-to-have, not the anchor. */
  blockText?: string
}
export type ReadyIntent = { type: 'ready'; filePath: string }
export type ClearIntent = { type: 'clear' }
/** Dismissal signals forwarded from inside the iframe: the parent cannot observe a click or a
 *  keydown in a cross-origin document, so a popover it owns would otherwise never learn about
 *  either. Payload-free — the parent decides what (if anything) they close. */
export type ClickAwayIntent = { type: 'clickAway' }
export type EscapeIntent = { type: 'escape' }
/** `C` pressed on a live selection inside the frame — "comment on this" from the keyboard. Fired
 *  liberally by the annotate client, which cannot see the parent's popover state; the reducer
 *  decides whether there is anything to open. */
export type CommentKeyIntent = { type: 'commentKey' }
/** A click that landed on a painted anchor (see annotate/reflow.ts's anchorIdAtPoint) — the page's
 *  only route back to the rail now that badges are gone. Intent-only, like every other message
 *  here: `id` is a thread id the parent looks up in its OWN loaded threads, so a forged one that
 *  matches nothing simply reveals nothing. */
export type AnchorClickIntent = { type: 'anchorClick'; id: string }
/** `⌘/Ctrl+K`-style "ask" shortcut pressed on a live selection inside the frame. Fired liberally
 *  by the annotate client, which cannot see the parent's popover state; the reducer decides
 *  whether there is anything to open — same contract as `CommentKeyIntent`. */
export type AskKeyIntent = { type: 'askKey' }
export type Intent =
  | SelectIntent
  | ReadyIntent
  | ClearIntent
  | ClickAwayIntent
  | EscapeIntent
  | CommentKeyIntent
  | AnchorClickIntent
  | AskKeyIntent

export type DOMRectLike = { top: number; left: number; width: number; height: number }

export type ExpectedSource = { origin: string; source: MessageEventSource | Window | null }

const MAX_FIELD = 2000 // chars per text field, bounds a single message
// Mirrors the api's TEXT_CONTEXT_LIMIT: the client captures at that width and the server stores at
// most that, so anything longer is noise the server would trim anyway.
export const MAX_CONTEXT = 64

const str = (v: unknown, max = MAX_FIELD): string | null =>
  typeof v === 'string' && v.length <= max ? v : null

// Like `str`, but CLAMPS an over-cap string to the cap rather than rejecting it — used for the
// free-text selection quote so a long highlight still opens the composer (anchored on the head of
// the quote) instead of being silently dropped. Selectors, by contrast, must never be truncated.
const clamp = (v: unknown, max = MAX_FIELD): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

// Prefix context carries signal at the end nearest the quote, so it clamps from the opposite side.
const clampTail = (v: unknown, max = MAX_FIELD): string | null => (typeof v === 'string' ? v.slice(-max) : null)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Best-effort occurrence context. Each side is clamped, not rejected — an over-long side would
 *  still be truncated server-side, and dropping the whole message over it would cost the comment.
 *  Undefined when neither side carries anything, so "no context" stays a single shape. */
const context = (v: unknown): TextContext | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const c = v as Record<string, unknown>
  const prefix = clampTail(c.prefix, MAX_CONTEXT) ?? ''
  const suffix = clamp(c.suffix, MAX_CONTEXT) ?? ''
  return prefix || suffix ? { prefix, suffix } : undefined
}

/** Best-effort selection rectangle (iframe-viewport coords). Untrusted — used only to position
 *  an overlay, never as authority. */
const rect = (v: unknown): DOMRectLike | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  return { top: num(r.top), left: num(r.left), width: num(r.width), height: num(r.height) }
}

/** Validate a message event from the content iframe. Returns a typed intent or null. */
export function parseIntent(event: MessageEvent, expected: ExpectedSource): Intent | null {
  if (event.origin !== expected.origin) return null
  if (expected.source && event.source !== expected.source) return null
  const data = event.data
  if (!data || typeof data !== 'object') return null

  switch ((data as { type?: unknown }).type) {
    case 'glance:select': {
      const d = data as { quote?: unknown; context?: unknown; rect?: unknown; blockText?: unknown }
      const quote = clamp(d.quote)
      if (!quote) return null
      const blockText = clamp(d.blockText) || undefined
      return { type: 'select', quote, context: context(d.context), rect: rect(d.rect), blockText }
    }
    // Element ("pinpoint") comment creation is dropped (slice C2a) — this parent no longer sends
    // glance:pending/composes on it. A STALE cached bundle (an old client.ts still running in
    // someone's tab) may still post `glance:pinpoint`; the correct outcome is to ignore it here,
    // same as any other unrecognised type, not to crash on it.
    case 'glance:select-clear':
      return { type: 'clear' }
    case 'glance:click-away':
      return { type: 'clickAway' }
    case 'glance:escape':
      return { type: 'escape' }
    case 'glance:comment-key':
      return { type: 'commentKey' }
    case 'glance:ask-key':
      return { type: 'askKey' }
    case 'glance:anchor-click': {
      const id = str((data as { id?: unknown }).id)
      return id ? { type: 'anchorClick', id } : null
    }
    case 'glance:ready': {
      const filePath = str((data as { filePath?: unknown }).filePath)
      return filePath ? { type: 'ready', filePath } : null
    }
    default:
      return null
  }
}
