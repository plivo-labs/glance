// Absolute deep-link for a comment notification, for delivery channels that need a full URL (Slack).
// A behavior-preserving MIRROR of web/src/lib/mentions.ts `notificationHref` + paths.ts
// `encodePathSegments` — packages don't cross-import (see lib/mime.ts), so the algorithm is
// duplicated, not shared. Difference from the web helper: it joins an absolute APP_URL (the in-app
// bell renders the relative form), trailing-slash safe.

/** Encode each path segment so `?`/`#` in a filename can't truncate the pathname into query/
 *  fragment territory. Mirror of web paths.ts. */
export const encodePathSegments = (filePath: string): string =>
  filePath.split('/').map(encodeURIComponent).join('/')

/** Absolute viewer link for a notification: `${APP_URL}/<siteLabel>/<encoded path>?thread=&review=1`.
 *  `review=1` is always present; `thread=` only when set; a missing site degrades to the app root. */
export function notificationLink(
  appUrl: string,
  n: { siteLabel: string | null; filePath: string | null; threadId: string | null },
): string {
  const base = appUrl.replace(/\/+$/, '')
  if (!n.siteLabel) return `${base}/`
  const path = n.filePath ? `/${encodePathSegments(n.filePath.replace(/^\/+/, ''))}` : ''
  const params = new URLSearchParams()
  if (n.threadId) params.set('thread', n.threadId)
  params.set('review', '1')
  return `${base}/${n.siteLabel}${path}?${params.toString()}`
}
