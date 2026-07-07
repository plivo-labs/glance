import type { DrizzleD1Database } from 'drizzle-orm/d1'

/** Worker bindings + secrets/vars. Secrets come from `.dev.vars` locally and
 *  `wrangler secret put` in prod; plain vars can live in wrangler.jsonc `vars`. */
export interface Bindings {
  GLANCE_DB: D1Database
  GLANCE_FILES: R2Bucket
  GLANCE_SESSIONS: KVNamespace
  ASSETS: Fetcher
  UPLOAD_LIMITER?: RateLimit
  // Workers AI, used to transcribe voice comments server-side. Declared unconditionally in
  // wrangler.jsonc so production always has it bound; typed optional purely so tests and any
  // binding-less deploy degrade gracefully — voice comments still post with a transcript
  // placeholder rather than erroring (see lib/transcribe).
  AI?: Ai
  // Optional: when unset, Google OAuth routes are inert (404) and login is bootstrap-only.
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // Optional one-shot secret gating first-superadmin bootstrap. Unset → bootstrap inert (404).
  BOOTSTRAP_TOKEN?: string
  SESSION_SECRET: string
  CONTENT_TOKEN_SECRET: string
  // Optional: separate HMAC secret for the shared-backend data-plane tokens (glance.db SDK).
  // Distinct from CONTENT_TOKEN_SECRET so a leaked content (view) token can't verify as a data
  // token. When unset, the /api/_data surface is inert (404) — the feature is opt-in per deploy.
  DATA_TOKEN_SECRET?: string
  APP_URL: string
  CONTENT_URL: string
  ALLOWED_HD: string
  SUPERADMIN_EMAIL: string
}

/** The minimal user identity stored in KV and attached to the request context. */
export interface SessionUser {
  id: string
  email: string
  name: string | null
  role: 'member' | 'superadmin'
}

/** Hono context variables set by middleware. */
export interface Variables {
  db: DrizzleD1Database
  user: SessionUser
  // Which credential authenticated the request, set by requireAuth. 'cli' = Bearer token,
  // 'web' = session cookie. Drives CLI-usage analytics. Absent on unauthenticated routes.
  authKind: 'cli' | 'web'
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }
