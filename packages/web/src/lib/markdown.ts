import { Marked } from 'marked'

// Client-side twin of packages/api/src/lib/markdown.ts — same hardened Marked config, verbatim.
// The two packages deliberately share no source (same convention as the twinned TextContext type,
// see packages/web/src/lib/comments.ts), so any change to the escaping/URL-scrubbing rules there
// must be mirrored here by hand.

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}

// Neutralize dangerous link/image URL schemes (javascript:, vbscript:, data: in links, …)
// while leaving relative paths, fragments, and http(s)/mailto intact. `data:` is allowed
// only for images, where the CSP img-src already permits it. Anything with a disallowed
// scheme collapses to a harmless target.
function safeUrl(href: string, allowData: boolean): string {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(href)
  if (!m) return href // relative / fragment / scheme-less — safe
  const scheme = m[1].toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return href
  if (allowData && scheme === 'data') return href
  return allowData ? '' : '#'
}

// Isolated marked instance that ESCAPES raw HTML instead of passing it through. Both
// block-level (`Tokens.HTML`) and inline (`Tokens.Tag`) raw-HTML tokens render via the
// `html` method, so escaping its `text` neutralizes `<script>`, `<img onerror>`, etc.
// `walkTokens` additionally scrubs unsafe schemes from `[text](url)` / `![alt](url)` before
// rendering, so e.g. `[x](javascript:alert(1))` can't produce a live javascript: URL.
// Normal markdown (headings, code, links, images, tables) is unaffected.
const markdown = new Marked({
  renderer: { html: ({ text }) => escapeHtml(text) },
  walkTokens: (token) => {
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') {
      token.href = safeUrl(token.href, token.type === 'image')
    }
  },
})

export function renderMarkdown(src: string): string {
  return markdown.parse(src) as string
}
