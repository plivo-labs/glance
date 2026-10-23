import { OAuth2Client } from 'arctic'
import type { Bindings } from '../types'
import { OAUTH_SCOPES } from './oauth'

export interface OidcEndpoints {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
}

export interface OidcClaims {
  iss?: string
  aud?: string | string[]
  exp?: number
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

// Only the resolved document is cached, never the in-flight promise: workerd refuses to let one
// request await I/O that another request started.
let discovered: OidcEndpoints | null = null

export async function discoverOidc(env: Bindings): Promise<OidcEndpoints> {
  const issuer = env.OIDC_ISSUER as string
  if (discovered?.issuer === issuer) return discovered
  const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const doc = (await res.json()) as Partial<OidcEndpoints>
  if (doc.issuer !== issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery document does not match the configured issuer')
  }
  discovered = { issuer, authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint }
  return discovered
}

export function resetOidcDiscovery(): void {
  discovered = null
}

/** The lowercased email to sign in as, or why the id_token is refused. The token came straight
 *  from the token endpoint over TLS, so its signature is not re-checked (OIDC Core 3.1.3.7); its
 *  issuer, audience, expiry and email are. */
export function acceptedOidcEmail(
  claims: OidcClaims,
  env: Bindings,
  now = Date.now(),
): { email: string } | { refused: string } {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== env.OIDC_ISSUER) return { refused: 'issuer' }
  if (!audiences.includes(env.OIDC_CLIENT_ID)) return { refused: 'audience' }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { refused: 'expired' }
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
  if (claims.email_verified !== true) return { refused: 'email not verified' }
  if (!email.endsWith(`@${env.ALLOWED_HD.toLowerCase()}`)) return { refused: 'email outside ALLOWED_HD' }
  return { email }
}

/** The groups the id_token carries in OIDC_GROUPS_CLAIM. A missing claim reads as no groups, so a
 *  user the provider stops sending groups for loses them rather than keeping stale access. */
export function oidcGroups(claims: OidcClaims, env: Bindings): string[] {
  const value = claims[env.OIDC_GROUPS_CLAIM || 'groups']
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : []
}
