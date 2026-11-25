import { OAuth2Client } from 'arctic'
import type { Bindings } from '../types'
import { OAUTH_SCOPES } from './oauth'

export interface OidcEndpoints {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri?: string
}

export interface OidcClaims {
  iss?: string
  aud?: string | string[]
  azp?: string
  exp?: number
  /** Required by OIDC; validated at runtime in acceptedOidcEmail because the claim is decoded from
   *  the token, not parsed from a typed document. */
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  [claim: string]: unknown
}

export function isOidcEnabled(env: Bindings): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET)
}

export function oidcProviderName(env: Bindings): string {
  return env.OIDC_PROVIDER_NAME || 'SSO'
}

export function oidcScopes(env: Bindings): string[] {
  return env.OIDC_SCOPES ? env.OIDC_SCOPES.split(/\s+/).filter(Boolean) : OAUTH_SCOPES
}

/** Call only when `isOidcEnabled`. redirectURI must be registered with the provider. */
export function createOidc(env: Bindings): OAuth2Client {
  if (!isOidcEnabled(env)) throw new Error('OIDC is not configured')
  return new OAuth2Client(
    env.OIDC_CLIENT_ID as string,
    env.OIDC_CLIENT_SECRET as string,
    `${env.APP_URL}/api/auth/oidc/callback`,
  )
}

/** The value stored in users.oidcSub. `sub` is unique per issuer, NOT globally, and a path-based
 *  issuer (Okta's org server and its authorization servers) reuses one. Storing the pair keeps a
 *  later OIDC_ISSUER change from signing someone into the account of the same `sub` elsewhere. */
export function oidcSubjectKey(issuer: string, sub: string): string {
  return `${issuer} ${sub}`
}

/** Refuses anything but https, because the id_token's signature is not re-checked: the token is
 *  trusted because it came straight from the token endpoint over TLS (OIDC Core 3.1.3.7). An
 *  http:// endpoint, or a discovery document pointing at one, would void that. */
function requireHttps(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`OIDC ${what} is missing`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`OIDC ${what} is not a URL: ${value}`)
  }
  if (url.protocol !== 'https:') throw new Error(`OIDC ${what} must be https: ${value}`)
  return value
}

// Only the resolved document is cached, never the in-flight promise: workerd refuses to let one
// request await I/O that another request started.
const discovered = new Map<string, OidcEndpoints>()

export async function discoverOidc(env: Bindings, issuerOverride?: string): Promise<OidcEndpoints> {
  const issuer = requireHttps(issuerOverride ?? env.OIDC_ISSUER, 'issuer')
  const known = discovered.get(issuer)
  if (known) return known
  const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const doc = (await res.json()) as Partial<OidcEndpoints>
  if (
    doc.issuer !== issuer ||
    !doc.authorization_endpoint ||
    !doc.token_endpoint
  ) {
    throw new Error('OIDC discovery document does not match the configured issuer')
  }
  const endpoints = {
    issuer,
    authorization_endpoint: requireHttps(doc.authorization_endpoint, 'authorization endpoint'),
    token_endpoint: requireHttps(doc.token_endpoint, 'token endpoint'),
    userinfo_endpoint: doc.userinfo_endpoint
      ? requireHttps(doc.userinfo_endpoint, 'userinfo endpoint')
      : undefined,
    jwks_uri: doc.jwks_uri ? requireHttps(doc.jwks_uri, 'jwks uri') : undefined,
  }
  discovered.set(issuer, endpoints)
  return endpoints
}

export function resetOidcDiscovery(): void {
  discovered.clear()
}

/** The id_token's claims completed from the userinfo endpoint, for providers whose id_token leaves
 *  out profile claims (Okta's org authorization server sends a "thin" one without `email`). The
 *  id_token wins where both have a claim, and a userinfo `sub` that differs is refused (OIDC Core
 *  5.3.2). `email` and `email_verified` come as a pair from whichever source has the email: merged
 *  per key, one source's `email_verified: true` would vouch for the other's address. */
export async function withUserinfo(
  claims: OidcClaims,
  endpoints: OidcEndpoints,
  accessToken: string,
): Promise<OidcClaims> {
  if (!endpoints.userinfo_endpoint) return claims
  const res = await fetch(endpoints.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`OIDC userinfo failed: ${res.status}`)
  const info = (await res.json()) as Record<string, unknown>
  if (info.sub !== claims.sub) throw new Error('OIDC userinfo subject does not match the id_token')
  const pair = typeof claims.email === 'string' ? claims : info
  return { ...info, ...claims, email: pair.email, email_verified: pair.email_verified } as OidcClaims
}

/** The lowercased email to sign in as, or why the id_token is refused. The token came straight
 *  from the token endpoint over TLS, so its signature is not re-checked (OIDC Core 3.1.3.7); its
 *  issuer, audience, authorized party, expiry, subject and email are. */
export function acceptedOidcEmail(
  claims: OidcClaims,
  env: Bindings,
  now = Date.now(),
): { email: string } | { refused: string } {
  if (claims.iss !== env.OIDC_ISSUER) return { refused: 'issuer' }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(env.OIDC_CLIENT_ID)) return { refused: 'audience' }
  // With several audiences the authorized party is the only one allowed to use the token; without
  // this check any of the other audience clients could replay it to us.
  if (audiences.length > 1 && claims.azp !== env.OIDC_CLIENT_ID) return { refused: 'authorized party' }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { refused: 'expired' }
  if (typeof claims.sub !== 'string' || claims.sub === '') return { refused: 'missing subject' }
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
  if (claims.email_verified !== true) return { refused: 'email not verified' }
  if (!email.endsWith(`@${env.ALLOWED_HD.toLowerCase()}`)) return { refused: 'email outside ALLOWED_HD' }
  return { email }
}

/** The group names the id_token carries in OIDC_GROUPS_CLAIM, or null when the provider did not
 *  say. An absent claim, a non-array value and Entra ID's group overage (the claim is replaced by
 *  `_claim_names`) are all "unknown": syncing them as an empty list would strip every managed
 *  membership and demote every admin on a token that merely omitted the groups. */
export function oidcGroups(claims: OidcClaims, env: Bindings): string[] | null {
  const claim = env.OIDC_GROUPS_CLAIM || 'groups'
  const overage = claims._claim_names
  if (overage && typeof overage === 'object' && claim in overage) return null
  const value = claims[claim]
  if (!Array.isArray(value)) return null
  return value.filter((group): group is string => typeof group === 'string')
}
