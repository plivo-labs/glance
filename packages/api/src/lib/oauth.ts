import { Google } from 'arctic'
import type { Bindings } from '../types'

export const OAUTH_SCOPES = ['openid', 'profile', 'email']

/** Google OAuth is usable only when both credentials are configured. When false the
 *  deploy runs bootstrap-only and the Google routes are inert. */
export function isGoogleEnabled(env: Bindings): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

/** Single source of truth for the Google client. redirectURI must exactly match an
 *  Authorized redirect URI in the Google Cloud console. Call only when
 *  `isGoogleEnabled` — guards above must keep undefined creds from reaching `new Google`. */
export function createGoogle(env: Bindings): Google {
  if (!isGoogleEnabled(env)) throw new Error('Google OAuth is not configured')
  return new Google(env.GOOGLE_CLIENT_ID as string, env.GOOGLE_CLIENT_SECRET as string, `${env.APP_URL}/api/auth/callback`)
}
