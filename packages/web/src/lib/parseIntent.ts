// Parent-side intent FILTER for messages from the annotate iframe (Step 12).
//
// This is explicitly a shape/size/source filter — NOT a trust or authority guard. Hostile
// uploaded HTML shares the content origin and can forge any message, so passing this filter
// proves nothing about intent. The real guard is the architectural invariant (COMMENTS_PLAN
// constraint 1): an iframe message may only OPEN UI or SUGGEST an anchor; every mutation is
// parent-initiated after an explicit user action, and all anchor resolution is server-side.

import type { TextContext } from '@/lib/comments'

export type SelectIntent = { type: 'select'; quote: string; context?: TextContext; rect?: DOMRectLike }
export type ReadyIntent = { type: 'ready'; filePath: string }
export type ClearIntent = { type: 'clear' }
/** A suggested element ("pinpoint") anchor — the iframe proposes a selector; the parent turns it
 *  into a pending element anchor + composer. Untrusted: selector is only ever querySelector'd. */
export type ElementAnchorIntent = { selector: string; tag: string; preview: string; textFallback: string }
export type PinpointIntent = { type: 'pinpoint'; anchor: ElementAnchorIntent; rect?: DOMRectLike }
/** Dismissal signals forwarded from inside the iframe: the parent cannot observe a click or a
 *  keydown in a cross-origin document, so a popover it owns would otherwise never learn about
 *  either. Payload-free — the parent decides what (if anything) they close. */
export type ClickAwayIntent = { type: 'clickAway' }
export type EscapeIntent = { type: 'escape' }
/** One reflow frame's worth of text-anchor positions (see annotate/reflow.ts). `epoch` tags the
 *  index VERSION the rects were measured under — the parent drops a batch whose epoch is behind
 *  the latest it's seen, so a bad epoch must fail the whole message rather than silently become
 *  the lowest possible epoch (which would make every later, real batch look stale forever). */
export type AnchorRectsIntent = { type: 'anchorRects'; epoch: number; rects: { id: string; rect: DOMRectLike }[] }
export type Intent = SelectIntent | ReadyIntent | ClearIntent | PinpointIntent | ClickAwayIntent | EscapeIntent | AnchorRectsIntent

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

/** Strict counterpart to `rect()` above, for anchor-rects entries. That helper is deliberately
 *  best-effort: a select/pinpoint chip with a coerced-to-0 edge just sits at a slightly wrong spot.
 *  Here a coerced 0 would park a badge at the page corner pointing at nothing (see reflow.ts's
 *  measurableRect, which the annotate client already applies before posting) — so a bad edge, or a
 *  collapsed/display:none zero-area box, must drop the entry instead of faking a position for it. */
const strictRect = (v: unknown): DOMRectLike | null => {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  // Narrowed one edge at a time rather than by an `.every` predicate over an array: a type guard on
  // the ARRAY's element type tells TypeScript nothing about the individual bindings, so `width > 0`
  // below would still be comparing `unknown` (and the whole thing would need an `as` cast to
  // compile — the cast being exactly how a coercion bug would slip back in unnoticed).
  const edge = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null)
  const top = edge(r.top)
  const left = edge(r.left)
  const width = edge(r.width)
  const height = edge(r.height)
  if (top === null || left === null || width === null || height === null) return null
  if (!(width > 0 || height > 0)) return null
  return { top, left, width, height }
}

/** Validate a message event from the content iframe. Returns a typed intent or null. */
export function parseIntent(event: MessageEvent, expected: ExpectedSource): Intent | null {
  if (event.origin !== expected.origin) return null
  if (expected.source && event.source !== expected.source) return null
  const data = event.data
  if (!data || typeof data !== 'object') return null

  switch ((data as { type?: unknown }).type) {
    case 'glance:select': {
      const d = data as { quote?: unknown; context?: unknown; rect?: unknown }
      const quote = clamp(d.quote)
      if (!quote) return null
      return { type: 'select', quote, context: context(d.context), rect: rect(d.rect) }
    }
    case 'glance:pinpoint': {
      const d = data as { selector?: unknown; tag?: unknown; preview?: unknown; textFallback?: unknown; rect?: unknown }
      const selector = str(d.selector)
      if (!selector) return null
      return {
        type: 'pinpoint',
        anchor: { selector, tag: str(d.tag) ?? '', preview: str(d.preview) ?? '', textFallback: str(d.textFallback) ?? '' },
        rect: rect(d.rect),
      }
    }
    case 'glance:select-clear':
      return { type: 'clear' }
    case 'glance:click-away':
      return { type: 'clickAway' }
    case 'glance:escape':
      return { type: 'escape' }
    case 'glance:anchor-rects': {
      const d = data as { epoch?: unknown; rects?: unknown }
      // Deliberately NOT num(): that helper coerces a bad epoch to 0, the LOWEST possible epoch, so
      // every later legitimate batch would compare as stale and the badges would freeze forever.
      if (typeof d.epoch !== 'number' || !Number.isFinite(d.epoch)) return null
      if (!Array.isArray(d.rects)) return null
      const rects: { id: string; rect: DOMRectLike }[] = []
      for (const entry of d.rects as unknown[]) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const id = str(e.id, MAX_FIELD)
        const r = strictRect(e.rect)
        if (id && r) rects.push({ id, rect: r })
      }
      return { type: 'anchorRects', epoch: d.epoch, rects }
    }
    case 'glance:ready': {
      const filePath = str((data as { filePath?: unknown }).filePath)
      return filePath ? { type: 'ready', filePath } : null
    }
    default:
      return null
  }
}
