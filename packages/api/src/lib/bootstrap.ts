// Pure decision cores for the token-gated first-superadmin bootstrap. No I/O here —
// the route feeds these the facts (token, DB state) and acts on the verdict, so the
// security-critical logic stays unit-testable.

const enc = new TextEncoder()

/**
 * Constant-time string equality. Double-HMAC under an ephemeral random key: both inputs
 * are reduced to fixed-length 32-byte MACs, so the only timing is over those fixed bytes —
 * leaking neither the length nor the content of the secrets. (Workers has no
 * `crypto.timingSafeEqual`; this mirrors the `crypto.subtle` pattern in `lib/token.ts`.)
 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const keyData = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ])
  const va = new Uint8Array(macA)
  const vb = new Uint8Array(macB)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}

export interface SuperadminStatus {
  hasSuperadmin: boolean
  /** Whether the existing superadmin (if any) is exactly SUPERADMIN_EMAIL. */
  superadminIsConfiguredEmail: boolean
}

export interface BootstrapDecisionInput {
  /** env.BOOTSTRAP_TOKEN — when unset the whole feature is inert. */
  expectedToken: string | undefined
  /** Token from the request body. */
  providedToken: string | undefined
  /** Lazily-read DB state — only awaited once the token verifies, so reject paths
   *  (inert / bad token) never touch the database. */
  status: () => Promise<SuperadminStatus>
}

export type BootstrapDecision = { ok: true } | { ok: false; status: 404 | 401 | 410 }

/**
 * Verdict for a bootstrap attempt. Order matters: an unset expected token is inert (404)
 * before any token compare; a bad token is rejected (401) before any DB state is consulted
 * (so attackers learn nothing about superadmin existence, and the reject path does no I/O).
 * Idempotent to avoid lockout — allowed when no superadmin exists OR the only superadmin is
 * already the configured email (re-mint a session); 410 only when a *different* superadmin
 * already owns the deploy.
 */
export async function bootstrapDecision(input: BootstrapDecisionInput): Promise<BootstrapDecision> {
  if (!input.expectedToken) return { ok: false, status: 404 }
  if (!(await secretEquals(input.providedToken ?? '', input.expectedToken))) return { ok: false, status: 401 }
  const { hasSuperadmin, superadminIsConfiguredEmail } = await input.status()
  if (!hasSuperadmin || superadminIsConfiguredEmail) return { ok: true }
  return { ok: false, status: 410 }
}

export interface PublicConfigInput {
  googleEnabled: boolean
  hasSuperadmin: boolean
  bootstrapTokenSet: boolean
}

/** Public first-run config. Bootstrap is offered only while a token is set and no
 *  superadmin exists yet; `googleEnabled` is passed through from `isGoogleEnabled`. */
export function buildPublicConfig(input: PublicConfigInput): { googleEnabled: boolean; bootstrapAvailable: boolean } {
  return {
    googleEnabled: input.googleEnabled,
    bootstrapAvailable: input.bootstrapTokenSet && !input.hasSuperadmin,
  }
}
