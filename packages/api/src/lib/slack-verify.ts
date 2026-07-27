// Slack request-signature verification for the events endpoint. Pure + injectable so it unit-tests
// directly. Slack signs every request to our Request URL; this is the ONLY thing standing between the
// endpoint and an anonymous POST, since Slack sends no cookie and no Origin (requireSameOrigin
// therefore passes it through untouched).
// Algorithm per https://docs.slack.dev/authentication/verifying-requests-from-slack/:
//   basestring = `v0:${timestamp}:${rawBody}` → HMAC-SHA256 with the signing secret → hex, `v0=`-prefixed.
// The crypto itself is lib/hmac.ts + lib/bootstrap.ts's secretEquals — never re-implemented here.

import { secretEquals } from './bootstrap'
import { hmacSignHex } from './hmac'

/** How far a request's timestamp may drift from now before we treat it as a replay. Slack's own
 *  guidance is five minutes; the timestamp is signed, so this is what bounds a captured request's
 *  usable lifetime. */
export const MAX_SKEW_SECONDS = 300

export type SlackSignatureInput = {
  signingSecret: string
  /** The `x-slack-request-timestamp` header, verbatim. */
  timestamp: string | undefined
  /** The `x-slack-signature` header, verbatim (`v0=<hex>`). */
  signature: string | undefined
  /** The RAW request body — the exact bytes Slack signed. Re-serializing parsed JSON breaks this. */
  body: string
  /** Current unix time in seconds (injected so the skew check is testable). */
  nowSeconds: number
}

/** True iff the request carries a fresh, correctly-signed Slack signature. Fails closed on every
 *  missing/malformed input — a blank secret can never verify, so an unconfigured deploy accepts
 *  nothing (the route also gates on the secret being set before it gets here). Never throws. */
export async function verifySlackSignature(input: SlackSignatureInput): Promise<boolean> {
  const { signingSecret, timestamp, signature, body, nowSeconds } = input
  if (!signingSecret.trim() || !timestamp || !signature) return false
  // Reject a stale (or future-dated) timestamp before spending a HMAC on it.
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false

  try {
    return await secretEquals(`v0=${await hmacSignHex(signingSecret, `v0:${timestamp}:${body}`)}`, signature)
  } catch {
    return false
  }
}
