import { b64urlDecode, b64urlEncode } from '../lib/hmac'

// The replay cursor: a client's position in ONE site's change stream, bound to ONE viewer.
//
// It is ENCRYPTED, not merely signed. A signed-but-readable cursor (the data-token wire shape)
// would hand the page the raw per-site seq, and the gaps between two positions count the
// mutations the viewer was NOT allowed to see — the exact leak constraint #9 forbids. AES-GCM
// gives opacity AND authenticity in one primitive, keyed off DATA_TOKEN_SECRET like every other
// data-plane credential, so a cursor from a foreign deploy simply fails to decrypt.
//
// siteId and viewerId ride INSIDE the ciphertext so the endpoint can hard-compare them against
// the verified token claims: a cursor is only ever valid for the identity that was issued it.

export type Cursor = { siteId: string; viewerId: string; seq: number }

const enc = new TextEncoder()
const dec = new TextDecoder()
// AES-GCM's standard nonce length; a fresh random one per mint, prepended to the ciphertext.
const IV_BYTES = 12

function cursorKey(secret: string): Promise<CryptoKey> {
  // Domain-separated from the token MACs that use the same secret directly.
  return crypto.subtle
    .digest('SHA-256', enc.encode(`glance-cursor:${secret}`))
    .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']))
}

/** Mint an opaque cursor for one (site, viewer, position). Never deterministic — two cursors for
 *  the same position differ, so a page cannot even order its own cursors. */
export async function encodeCursor(secret: string, cursor: Cursor): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await cursorKey(secret)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(cursor)))
  const out = new Uint8Array(IV_BYTES + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), IV_BYTES)
  return b64urlEncode(out.buffer as ArrayBuffer)
}

/** Decrypt + validate a cursor. Null on ANY failure — a tampered cursor must never degrade into
 *  "start from zero", which would replay a site's whole history. Callers still have to compare
 *  the returned siteId/viewerId against their verified claims. */
export async function decodeCursor(secret: string, cursor: string | null | undefined): Promise<Cursor | null> {
  if (!cursor) return null
  try {
    const bytes = b64urlDecode(cursor)
    if (bytes.byteLength <= IV_BYTES) return null
    const key = await cursorKey(secret)
    const iv = bytes.subarray(0, IV_BYTES)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.subarray(IV_BYTES))
    const c: Cursor = JSON.parse(dec.decode(pt))
    if (typeof c?.siteId !== 'string' || !c.siteId) return null
    if (typeof c.viewerId !== 'string' || !c.viewerId) return null
    if (!Number.isInteger(c.seq) || c.seq < 0) return null
    return { siteId: c.siteId, viewerId: c.viewerId, seq: c.seq }
  } catch {
    return null
  }
}
