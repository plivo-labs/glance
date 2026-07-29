// Google profile photos. The `picture` claim is Google-signed, so it is not attacker-controlled —
// but it is the ONE URL this worker ever fetches on a user's behalf, so the host is pinned both
// where it is STORED (login) and again where it is FETCHED (the avatar route). Defense in depth:
// a future write path that trusts a different source can't turn the proxy into an SSRF gadget.

const AVATAR_HOST_SUFFIX = '.googleusercontent.com'

/** The claim's URL if it is an https googleusercontent.com photo, else null (→ initials). */
export function sanitizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  return url.hostname.endsWith(AVATAR_HOST_SUFFIX) ? url.toString() : null
}

/** Requested pixel size for the proxied photo. Google encodes it in the URL's `=s<N>-c` suffix;
 *  rewriting it means we fetch a 96px thumbnail rather than the full-resolution original for a
 *  24px UI avatar. Unrecognized shapes are left alone — Google serves a default size. */
export function sizedAvatarUrl(url: string, size = 96): string {
  return url.replace(/=s\d+(-c)?$/, `=s${size}-c`)
}
