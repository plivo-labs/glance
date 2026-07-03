import { createMiddleware } from 'hono/factory'
import { fireAndForget, parseCliVersion, recordEvent } from '../lib/events'
import type { AppEnv } from '../types'

// CLI-usage analytics. Mounted on /api/*, it runs AFTER the route (so requireAuth has set
// authKind + user), then records one event per Bearer-authenticated (CLI) request. `action` is
// the top-level resource segment — 'upload' (deploy), 'sites' (read/viewer), 'users', etc. — a
// stable command bucket that covers every current and future CLI endpoint. The write is handed
// to waitUntil (never blocks the response) and web traffic is skipped entirely.
export const trackCliUsage = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  if (c.get('authKind') !== 'cli') return
  const action = c.req.path.replace(/^\/api\//, '').split('/')[0] || 'root'
  await fireAndForget(
    c,
    recordEvent(c.get('db'), {
      type: 'cli',
      action,
      userId: c.get('user')?.id ?? null,
      cliVersion: parseCliVersion(c.req.header('User-Agent')),
    }),
  )
})
