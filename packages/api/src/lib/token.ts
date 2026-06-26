// HMAC-signed, expiring tokens for gated content access. The main worker mints a
// token (scope = "space/site") bound to the viewer's userId after an access check; the
// content worker verifies it AND re-runs the access check against live DB state, so a
// revoked share or tightened visibility takes effect immediately. Constant-time
// comparison via crypto.subtle.verify — Workers has no crypto.timingSafeEqual, and
// `mac === mac` would leak timing.

const enc = new TextEncoder()

function b64urlEncode(buf: ArrayBuffer): string {
  let s = ''
  const bytes = new Uint8Array(buf)
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

// The signed payload binds the viewer identity, the resource scope, and the expiry —
// changing any one of them invalidates the MAC. userId is base64url-encoded so it can't
// collide with the `.` field separators in the token.
function payload(userId: string, scope: string, exp: number): string {
  return `${b64urlEncode(enc.encode(userId).buffer as ArrayBuffer)}.${scope}.${exp}`
}

/**
 * Returns "<expUnixSec>.<userId>.<base64url(hmac)>" binding `userId` + `scope` for
 * `ttlSec` seconds. The HMAC covers userId + scope + exp, so the token is only valid for
 * the user it was minted for.
 */
export async function signToken(secret: string, userId: string, scope: string, ttlSec = 300): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const key = await hmacKey(secret)
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(payload(userId, scope, exp)))
  return `${exp}.${b64urlEncode(enc.encode(userId).buffer as ArrayBuffer)}.${b64urlEncode(mac)}`
}

/**
 * Verify `token` against `scope`. Returns the bound userId on success (so the content
 * worker can reconstruct identity and re-authorize), or null if the token is missing,
 * malformed, expired, or its signature does not match.
 */
export async function verifyToken(secret: string, scope: string, token: string | null | undefined): Promise<string | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [expStr, userIdB64, macB64] = parts
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return null
  let userId: string
  let mac: Uint8Array
  try {
    userId = new TextDecoder().decode(b64urlDecode(userIdB64))
    mac = b64urlDecode(macB64)
  } catch {
    return null
  }
  if (!userId) return null
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, mac, enc.encode(payload(userId, scope, exp)))
  return ok ? userId : null
}
