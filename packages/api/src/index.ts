import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { withDb } from './db/client'
import { superadminExists } from './db/repo'
import { GLANCE_SDK_JS } from './glance-sdk'
import { buildPublicConfig } from './lib/bootstrap'
import { INSTALL_SH } from './install-script'
import { isGoogleEnabled } from './lib/oauth'
import { trackCliUsage } from './middleware/analytics'
import { requireSameOrigin } from './middleware/auth'
import { admin } from './routes/admin'
import { auth } from './routes/auth'
import { comments } from './routes/comments'
import { dataApi, dataToken } from './routes/data'
import { sites } from './routes/sites'
import { spaces } from './routes/spaces'
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

// Shared-backend browser SDK. Public GET (no auth/db) registered before the guards; no-store so
// SDK updates land immediately while the surface is young.
app.get('/api/glance.js', (c) =>
  c.body(GLANCE_SDK_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }),
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
// Comments live under /api/sites/:space/:site/comments — three segments, so no collision with
// the two-segment site routes above. Mounted separately to keep the comments surface isolated.
app.route('/api/sites', comments)
app.route('/api/upload', upload)
// Session-authenticated mint for shared-backend data tokens (owner → read+write, viewer → read).
app.route('/api/data-token', dataToken)
app.route('/api/users', users)
app.route('/api/admin', admin)

export default app
