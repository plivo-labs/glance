import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { withDb } from './db/client'
import { superadminExists } from './db/repo'
import { GLANCE_DB_JS } from './glancedb/bundle'
import { buildPublicConfig } from './lib/bootstrap'
import { INSTALL_SH } from './install-script'
import { isGoogleEnabled } from './lib/oauth'
import { trackCliUsage } from './middleware/analytics'
import { requireSameOrigin } from './middleware/auth'
import { admin } from './routes/admin'
import { apiKeys } from './routes/api-keys'
import { ask } from './routes/ask'
import { auth } from './routes/auth'
import { avatars } from './routes/avatars'
import { commentFeed } from './routes/comment-feed'
import { comments } from './routes/comments'
import { summary } from './routes/summary'
import { dataApi, dataToken } from './routes/data'
import { notifications } from './routes/notifications'
import { whatsNew } from './routes/whats-new'
import { sites } from './routes/sites'
import { slackEvents } from './routes/slack-events'
import { spaces } from './routes/spaces'
import { stars } from './routes/stars'
import { upload } from './routes/upload'
import { users } from './routes/users'
import type { AppEnv } from './types'

// Main worker: /api/* (Hono) + the React SPA (static assets, configured in wrangler.jsonc).
// `run_worker_first: ["/api/*"]` routes API calls here; everything else falls through to
// the asset layer, which serves index.html for unknown paths (SPA client routing).
const app = new Hono<AppEnv>()

// CSP is built per-request so frame-src can reference the content origin (env-specific).
// 'unsafe-inline' is needed only for React inline style attributes; scripts stay 'self'.
app.use('*', (c, next) =>
  secureHeaders({
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", c.env.CONTENT_URL],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  })(c, next),
)
// Public installer: serves the repo-root install.sh (single source via build:install) with
// GLANCE_API_URL defaulted to THIS origin, so `curl -fsSL <origin>/api/install | sh` lands a CLI
// already pointed here — no env to set. Registered BEFORE the /api/* guards: it needs no DB and
// must accept plain curl (no Origin / no cookie). Lives under /api/* so run_worker_first reaches
// the worker instead of the SPA asset fallback.
app.get('/api/install', (c) => {
  const origin = new URL(c.req.url).origin
  const script = INSTALL_SH.replace(
    '#!/bin/sh\nset -eu\n',
    `#!/bin/sh\nset -eu\n\n# Defaulted by ${origin}/api/install — export GLANCE_API_URL before piping to override.\nGLANCE_API_URL="\${GLANCE_API_URL:-${origin}}"\n`,
  )
  return c.text(script, 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
})

// Shared-backend browser SDK (built from src/glancedb/client.ts — bun run build:db). Public GET
// (no auth/db) registered before the guards; no-store so SDK updates land immediately while the
// surface is young. Hosted pages get the same client injected by the content worker instead.
app.get('/api/glance.js', (c) =>
  c.body(GLANCE_DB_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }),
)

// Shared-backend data plane. Registered BEFORE the /api/* guards (like /api/install): it is
// bearer-token authenticated and cross-origin from the content origin, so it must NOT inherit
// the cookie-based same-origin CSRF guard, and it manages its own DB + CORS. See routes/data.ts.
app.route('/api/_data', dataApi)

app.use('/api/*', requireSameOrigin)
app.use('/api/*', withDb)
app.use('/api/*', trackCliUsage)

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Public first-run config: what login options the SPA should offer. Behind requireSameOrigin
// + withDb (GET same-origin is fine); exposes only booleans, no secrets.
app.get('/api/config', async (c) =>
  c.json(
    buildPublicConfig({
      googleEnabled: isGoogleEnabled(c.env),
      hasSuperadmin: await superadminExists(c.get('db')),
      bootstrapTokenSet: Boolean(c.env.BOOTSTRAP_TOKEN),
    }),
  ),
)
app.route('/api/auth', auth)
app.route('/api/spaces', spaces)
app.route('/api/sites', sites)
// Stars (GET /starred, POST|DELETE /:space/:site/star) mount BEFORE comments/summary: those two
// groups each register `use('*', requireAuth)` across /api/sites/*, and Hono runs middleware in
// registration order — anything mounted after them pays their auth reads on top of its own. The
// zero-star spec in sites-starred.test.ts pins /starred at ONE post-auth D1 request, but it runs
// against test/route-fixtures.ts, which MIRRORS this order rather than importing it — so a reorder
// here must be made there too, or the spec keeps passing while production regresses.
app.route('/api/sites', stars)
// Comments live under /api/sites/:space/:site/comments — three segments, so no collision with
// the two-segment site routes above. Mounted separately to keep the comments surface isolated.
app.route('/api/sites', comments)
// Summaries share the same three-segment isolation as comments and cannot shadow site routes.
app.route('/api/sites', summary)
// Ask shares the same three-segment isolation as comments/summary and cannot shadow site routes.
app.route('/api/sites', ask)
app.route('/api/comments', commentFeed)
app.route('/api/upload', upload)
// Session-authenticated mint for shared-backend data tokens (owner → read+write, viewer → read).
app.route('/api/data-token', dataToken)
app.route('/api/users', users)
// Same-origin proxy for Google profile photos — keeps googleusercontent URLs (and viewer IPs)
// off the browser, so the CSP above stays `img-src 'self'`.
app.route('/api/avatars', avatars)
app.route('/api/notifications', notifications)
// Self-service control-plane API keys (mint/list/revoke), scoped to the caller's own keys.
app.route('/api/api-keys', apiKeys)
app.route('/api/whats-new', whatsNew)
app.route('/api/admin', admin)
// Slack Events API (link_shared → chat.unfurl). Authenticated by Slack's HMAC signature, not a
// session: requireSameOrigin above only guards COOKIE-authed unsafe methods, so this cookieless
// POST passes through it untouched and the signature check inside the route is the real gate.
app.route('/api/slack', slackEvents)

// The Durable Object class must be a NAMED export of the module wrangler.jsonc points `main` at,
// or the SITE_ROOM binding (class_name: "SiteRoom") fails to resolve at deploy time.
export { SiteRoom } from './realtime/site-room'

export default app
