// Pure element-locator helpers for the annotate client. BROWSER code (operates on DOM nodes) but
// GLOBAL-FREE: every function takes the node/root it works on, so it is unit-testable under a
// constructed DOM (happy-dom) with NO global registration. Bundled into client.ts by
// scripts/build-annotate.ts; excluded from the worker tsconfig (uses DOM types).
//
// A comment can anchor to a whole element (chart/table/image). The hostile iframe SUGGESTS a CSS
// selector (computeSelector); the trusted painter re-finds it (resolveSelector). Selectors are
// STRUCTURAL — a nearest-unique-id anchor plus `tag:nth-of-type(k)` child steps — so they survive
// across redeploys AS LONG AS the DOM shape is stable. A removed node resolves to null (orphaned);
// a sibling shifted into its slot resolves to the WRONG node — which is why we also capture a
// textFallback + preview describing the element (describeElement).

const PREVIEW_MAX = 120
const FALLBACK_MAX = 400

/** 1-based index of `el` among its same-tag element siblings (for `:nth-of-type`). */
function nthOfType(el: Element): number {
  let i = 1
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++
  return i
}

/** An `[id="…"]` selector. The attribute form avoids a CSS.escape dependency and handles arbitrary
 *  (even CSS-illegal) ids from uploaded HTML; only `"` and `\` need escaping. */
function idSelector(id: string): string {
  return `[id="${id.replace(/(["\\])/g, '\\$1')}"]`
}

/** True when `id` identifies EXACTLY ONE element in the node's document — only then is it a safe,
 *  unambiguous anchor. */
function isUniqueId(el: Element): boolean {
  if (!el.id) return false
  const doc = el.ownerDocument
  if (!doc) return false
  try {
    return doc.querySelectorAll(idSelector(el.id)).length === 1
  } catch {
    return false
  }
}

/** Build a structural selector for `el`: descend from the nearest unique-id ancestor (or the
 *  body/html root) via `tag:nth-of-type(k)` child steps. Deterministic; round-trips through
 *  resolveSelector on an unchanged DOM. */
export function computeSelector(el: Element): string {
  const parts: string[] = []
  for (let node: Element | null = el; node && node.nodeType === 1; node = node.parentElement) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') {
      parts.unshift(tag)
      break
    }
    if (isUniqueId(node)) {
      parts.unshift(idSelector(node.id))
      break
    }
    parts.unshift(`${tag}:nth-of-type(${nthOfType(node)})`)
  }
  return parts.join(' > ')
}

/** Re-find a suggested selector under `root`. Untrusted input is only ever `querySelector`'d (never
 *  eval'd); a malformed selector or a missing target both yield null. */
export function resolveSelector(selector: string, root: ParentNode): Element | null {
  if (!selector) return null
  try {
    return root.querySelector(selector)
  } catch {
    return null
  }
}

/** Describe an element for the composer + the orphaned fallback: its tag, a short human preview
 *  (aria-label / alt / title / text / tag, in that order), and a bounded text fallback. Pure. */
export function describeElement(el: Element): { tag: string; preview: string; textFallback: string } {
  const tag = el.tagName.toLowerCase()
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const labelled = el.getAttribute?.('aria-label') || el.getAttribute?.('alt') || el.getAttribute?.('title') || ''
  const preview = (labelled || text || tag).trim().slice(0, PREVIEW_MAX)
  return { tag, preview, textFallback: text.slice(0, FALLBACK_MAX) }
}
