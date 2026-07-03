// Shared HMAC-SHA256 primitives (base64url) for signing/verifying compact tokens.
// Verification is constant-time via crypto.subtle.verify — Workers has no
// crypto.timingSafeEqual, and a naive `mac === mac` string compare would leak timing.
// THE single copy of this crypto: both token formats (lib/token.ts content tokens,
// lib/data-token.ts data tokens) build on these — never re-implement or inline them.

const enc = new TextEncoder()

export function b64urlEncode(buf: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) => c.charCodeAt(0))
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** base64url(HMAC-SHA256(secret, message)). */
export async function hmacSign(secret: string, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await importKey(secret), enc.encode(message))
  return b64urlEncode(mac)
}

/** Constant-time verify of a base64url MAC against `message`. False on any decode error. */
export async function hmacVerify(secret: string, message: string, macB64: string): Promise<boolean> {
  let mac: Uint8Array
  try {
    mac = b64urlDecode(macB64)
  } catch {
    return false
  }
  return crypto.subtle.verify('HMAC', await importKey(secret), mac, enc.encode(message))
}
