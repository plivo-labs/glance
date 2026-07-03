// HMAC-signed, expiring tokens for gated content access. The main worker mints a
// token (scope = "space/site") bound to the viewer's userId after an access check; the
// content worker verifies it AND re-runs the access check against live DB state, so a
// revoked share or tightened visibility takes effect immediately. Crypto primitives are
// the shared ones in lib/hmac.ts (constant-time verify); the wire format is unchanged.

import { b64urlDecode, b64urlEncode, hmacSign, hmacVerify } from './hmac'

const enc = new TextEncoder()

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
  const mac = await hmacSign(secret, payload(userId, scope, exp))
  return `${exp}.${b64urlEncode(enc.encode(userId).buffer as ArrayBuffer)}.${mac}`
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
  try {
    userId = new TextDecoder().decode(b64urlDecode(userIdB64))
  } catch {
    return null
  }
  if (!userId) return null
  return (await hmacVerify(secret, payload(userId, scope, exp), macB64)) ? userId : null
}
