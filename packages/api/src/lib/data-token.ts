import { b64urlDecode, b64urlEncode, hmacSign, hmacVerify } from './hmac'

// A data-plane capability token — DISTINCT from the content/view token (lib/token.ts).
// Two properties matter for the shared-backend threat model:
//   1. SEPARATE SECRET (DATA_TOKEN_SECRET, not CONTENT_TOKEN_SECRET) + a different wire
//      shape, so a leaked/replayed *content* token can never verify as a data token
//      (P0: token type confusion).
//   2. EVERY claim — audience, siteId, viewerId, capabilities, expiry — is inside the MAC
//      (the signature covers the whole JSON body), so a token that lives in a page cannot
//      have its capabilities widened without invalidating the signature (P0: token forgery).
// Wire format: base64url(JSON(claims)) '.' base64url(hmac(body)).

// read     — read your own documents (and any `shared-*` collection)
// create   — add new documents, always attributed to you (every authorized viewer gets this)
// write    — update/delete documents (scoped to your own; owner-only)
// read_all — read every document in the site regardless of creator; with write, also delete
//            any document (owner/superadmin moderation)
export type DataCapability = 'read' | 'create' | 'write' | 'read_all'

export interface DataClaims {
  aud: 'data'
  siteId: string
  viewerId: string
  caps: DataCapability[]
  exp: number // unix seconds
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const CAPS: ReadonlySet<string> = new Set<DataCapability>(['read', 'create', 'write', 'read_all'])

/** Mint a data token binding the viewer to a single site + capability set for `ttlSec`. */
export async function signDataToken(
  secret: string,
  claims: { siteId: string; viewerId: string; caps: DataCapability[] },
  ttlSec = 300,
): Promise<string> {
  const full: DataClaims = {
    aud: 'data',
    siteId: claims.siteId,
    viewerId: claims.viewerId,
    caps: claims.caps,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  }
  const body = b64urlEncode(enc.encode(JSON.stringify(full)).buffer as ArrayBuffer)
  return `${body}.${await hmacSign(secret, body)}`
}

/**
 * Verify a data token: recompute the MAC over the exact body bytes, then parse + validate
 * the claims. Returns the claims on success or null if the token is missing, malformed,
 * wrong-audience, expired, or its signature does not match. Callers derive siteId/viewerId
 * from the RETURN value only — never from client-supplied request fields.
 */
export async function verifyDataToken(secret: string, token: string | null | undefined): Promise<DataClaims | null> {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  if (!(await hmacVerify(secret, body, token.slice(dot + 1)))) return null
  let claims: DataClaims
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(body)))
  } catch {
    return null
  }
  if (claims?.aud !== 'data') return null
  if (typeof claims.siteId !== 'string' || !claims.siteId) return null
  if (typeof claims.viewerId !== 'string' || !claims.viewerId) return null
  if (!Array.isArray(claims.caps) || !claims.caps.every((cap) => CAPS.has(cap))) return null
  if (!Number.isFinite(claims.exp) || Math.floor(Date.now() / 1000) > claims.exp) return null
  return claims
}

/** True iff the verified claims grant `cap`. */
export function hasCap(claims: DataClaims, cap: DataCapability): boolean {
  return claims.caps.includes(cap)
}
