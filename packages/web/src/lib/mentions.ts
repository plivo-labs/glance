// Pure @-mention helpers, extracted from the Composer so they're bun-testable without a DOM.
// The composer owns the textarea + dropdown; these own the string math plus notification/feed-row
// link and display helpers.

import { slugify } from './slug'

export interface MentionUser {
  id: string
  name: string | null
  email: string
}

/** Display label for a mentionable user (name, falling back to email). */
export const mentionLabel = (u: MentionUser): string => u.name ?? u.email

/** The active @-token immediately left of the caret, or null. A token starts at an `@` that sits at
 *  the start of the text or right after whitespace (so `a@b.com` never triggers) and runs up to the
 *  caret with no whitespace in between. `query` is what's typed after the `@` (may be empty right
 *  after typing `@`); `start` is the `@`'s index (where insertion replaces from). */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : ''
      if (i === 0 || /\s/.test(prev)) return { query: text.slice(i + 1, caret), start: i }
      return null // `@` glued to a word (email-like) — not a mention trigger
    }
    if (/\s/.test(ch)) return null // whitespace before an `@` — no active token
  }
  return null
}

/** Replace the active @-token with `@Label ` (trailing space so the next word is clear of it) and
 *  return the new text + caret position just past the inserted mention. A no-op (returns the input)
 *  if there's no active token at the caret. */
export function insertMention(
  text: string,
  caret: number,
  user: MentionUser,
): { text: string; caret: number } {
  const active = mentionQuery(text, caret)
  if (!active) return { text, caret }
  const inserted = `@${mentionLabel(user)} `
  const head = text.slice(0, active.start) + inserted
  return { text: head + text.slice(caret), caret: head.length }
}

/** Candidates for the dropdown: users whose label or email contains the (case-insensitive) query,
 *  capped to a short list. An empty query returns the head of the list. */
export function filterMentions(users: MentionUser[], query: string, limit = 6): MentionUser[] {
  const q = query.toLowerCase()
  return users
    .filter((u) => mentionLabel(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .slice(0, limit)
}

/** Deep-link for a notification: the viewer route for its site + file, opening the review rail on
 *  the referenced thread. Mirrors the viewer's `/:space/:site/<path>?thread=<id>&review=1` contract.
 *  `siteLabel` is the denormalized "space/slug"; a missing file/thread degrades gracefully. */
export function notificationHref(n: {
  siteLabel: string | null
  filePath: string | null
  threadId: string | null
}): string {
  if (!n.siteLabel) return '/'
  // Encode each path segment (mirrors ViewerSidebar's entryHref) — upload sanitization lets `?`
  // and `#` through, and unencoded they truncate the pathname into query/fragment territory.
  const path = n.filePath
    ? `/${n.filePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`
    : ''
  const params = new URLSearchParams()
  if (n.threadId) params.set('thread', n.threadId)
  params.set('review', '1')
  return `/${n.siteLabel}${path}?${params.toString()}`
}

/** Hide a root file path when it only repeats the site identity. Nested paths remain useful
 *  context even when their basename matches the site slug. */
export function feedRowPath(item: { filePath: string; siteSlug: string }): string | null {
  if (item.filePath === 'index.html') return null
  if (item.filePath.includes('/')) return item.filePath
  const basename = item.filePath.replace(/\.[^.]*$/, '')
  return slugify(basename) === item.siteSlug ? null : item.filePath
}
