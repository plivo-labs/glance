// Parent-side intent FILTER for messages from the annotate iframe (Step 12).
//
// This is explicitly a shape/size/source filter — NOT a trust or authority guard. Hostile
// uploaded HTML shares the content origin and can forge any message, so passing this filter
// proves nothing about intent. The real guard is the architectural invariant (COMMENTS_PLAN
// constraint 1): an iframe message may only OPEN UI or SUGGEST an anchor; every mutation is
// parent-initiated after an explicit user action, and all anchor resolution is server-side.

export type SelectIntent = { type: 'select'; quote: string; rect?: DOMRectLike }
export type ReadyIntent = { type: 'ready'; filePath: string }
export type ClearIntent = { type: 'clear' }
/** A suggested element ("pinpoint") anchor — the iframe proposes a selector; the parent turns it
 *  into a pending element anchor + composer. Untrusted: selector is only ever querySelector'd. */
export type ElementAnchorIntent = { selector: string; tag: string; preview: string; textFallback: string }
export type PinpointIntent = { type: 'pinpoint'; anchor: ElementAnchorIntent; rect?: DOMRectLike }
export type Intent = SelectIntent | ReadyIntent | ClearIntent | PinpointIntent

export type DOMRectLike = { top: number; left: number; width: number; height: number }

export type ExpectedSource = { origin: string; source: MessageEventSource | Window | null }

const MAX_FIELD = 2000 // chars per text field, bounds a single message

const str = (v: unknown, max = MAX_FIELD): string | null =>
  typeof v === 'string' && v.length <= max ? v : null

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

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
      const d = data as { quote?: unknown; rect?: unknown }
      const quote = str(d.quote)
      if (!quote) return null
      return { type: 'select', quote, rect: rect(d.rect) }
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
    case 'glance:ready': {
      const filePath = str((data as { filePath?: unknown }).filePath)
      return filePath ? { type: 'ready', filePath } : null
    }
    default:
      return null
  }
}
