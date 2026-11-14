import type { Bindings } from '../types'
import { b64urlDecode } from './hmac'
import { discoverOidc, type OidcClaims } from './oidc'

export function isOidcBearerEnabled(env: Bindings): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLI_CLIENT_ID)
}

const cliIssuer = (env: Bindings) => env.OIDC_CLI_ISSUER || (env.OIDC_ISSUER as string)

/** What `glance login` needs to run the provider's device flow; null while the feature is off. */
export function cliOidcConfig(env: Bindings) {
  if (!isOidcBearerEnabled(env)) return null
  return {
    issuer: cliIssuer(env),
    clientId: env.OIDC_CLI_CLIENT_ID as string,
    scope: env.OIDC_CLI_SCOPE || 'openid profile offline_access',
    tokenUse: env.OIDC_CLI_TOKEN === 'access' ? 'access' : 'id',
  }
}

const SKEW_SECONDS = 60
const JWKS_REFETCH_MS = 60_000
const JWKS_MAX_AGE_MS = 60 * 60_000

type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string }
let keys: { uri: string; fetchedAt: number; byKid: Map<string, CryptoKey> } | null = null

export function resetOidcKeys(): void {
  keys = null
}

async function loadKeys(uri: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(uri)
  if (!res.ok) throw new Error(`OIDC jwks failed: ${res.status}`)
  const byKid = new Map<string, CryptoKey>()
  for (const jwk of ((await res.json()) as { keys: Jwk[] }).keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue
    // A set also publishes keys for other uses (encryption) and algorithms; only RS256 signing
    // keys are ours, and one key that does not import must not take the valid ones down with it.
    if ((jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue
    try {
      const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      byKid.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']))
    } catch (err) {
      console.warn(`oidc: skipping jwks key ${jwk.kid}`, err)
    }
  }
  return byKid
}

/** The provider's signing key `kid`. An unknown kid refetches the set, at most once a minute, so a
 *  key rotation is picked up without letting a forged kid turn every request into a fetch. A set
 *  older than an hour is refetched too, so a key the provider withdrew stops being trusted; if that
 *  refetch fails the old set serves on, because a provider blip must not sign every CLI out. */
async function signingKey(uri: string, kid: string, now: number): Promise<CryptoKey | null> {
  if (keys?.uri !== uri) keys = { uri, fetchedAt: 0, byKid: new Map() }
  const age = now - keys.fetchedAt
  if (age > JWKS_MAX_AGE_MS || (!keys.byKid.has(kid) && age > JWKS_REFETCH_MS)) {
    try {
      keys = { uri, fetchedAt: now, byKid: await loadKeys(uri) }
    } catch (err) {
      if (keys.fetchedAt === 0) throw err
      console.warn('oidc: jwks refresh failed, keeping the cached keys', err)
    }
  }
  return keys.byKid.get(kid) ?? null
}

/** True for a compact JWS (three dot-separated parts), the shape of the provider's tokens; CLI
 *  tokens and API keys never look like one. */
/** When the person behind a token signed in: `auth_time` survives a refresh (OIDC Core 12.2), so a
 *  refreshed token cannot outrun a revocation; `iat` is the fallback for tokens without it. */
export function oidcSignedInAt(claims: OidcClaims): number {
  if (typeof claims.auth_time === 'number') return claims.auth_time
  return typeof claims.iat === 'number' ? claims.iat : 0
}

export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3
}

/** The claims of a provider-issued bearer token, or null when it must be refused. The signature is
 *  verified against the provider's published keys, then issuer, audience and expiry are checked:
 *  an ID token carries the CLI client id as `aud`; an access token from a custom authorization
 *  server carries OIDC_CLI_AUDIENCE and names the client in `cid`. */
export async function verifyOidcBearer(env: Bindings, token: string, now = Date.now()): Promise<OidcClaims | null> {
  if (!isOidcBearerEnabled(env) || !looksLikeJwt(token)) return null
  try {
    const [head, body, sig] = token.split('.')
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(head))) as { alg?: string; kid?: string }
    if (header.alg !== 'RS256' || !header.kid) return null

    const endpoints = await discoverOidc(env, cliIssuer(env))
    if (!endpoints.jwks_uri) return null
    const key = await signingKey(endpoints.jwks_uri, header.kid, now)
    if (!key) return null
    const signed = new TextEncoder().encode(`${head}.${body}`)
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(sig), signed))) return null

    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Record<string, unknown>
    const seconds = now / 1000
    if (claims.iss !== cliIssuer(env)) return null
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS <= seconds) return null
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > seconds) return null

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const accessToken = env.OIDC_CLI_TOKEN === 'access'
    const audienceOk = accessToken
      ? Boolean(env.OIDC_CLI_AUDIENCE) &&
        audiences.includes(env.OIDC_CLI_AUDIENCE) &&
        claims.cid === env.OIDC_CLI_CLIENT_ID
      : audiences.includes(env.OIDC_CLI_CLIENT_ID) &&
        // Same rule as the browser sign-in (lib/oidc.ts): of several audiences only the authorized
        // party may use an ID token.
        (audiences.length === 1 || claims.azp === env.OIDC_CLI_CLIENT_ID)
    if (!audienceOk) return null
    return typeof claims.sub === 'string' && claims.sub ? (claims as OidcClaims) : null
  } catch {
    return null
  }
}
