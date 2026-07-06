import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { fireAndForget, parseCliVersion, recordEvent } from '../lib/events'
import { readSessionOrBearer } from '../lib/session'
import type { AppEnv } from '../types'

const SESSION_COOKIE = 'glance_session'

// A request is a CLI call when it carries a Bearer token and NO session cookie — the exact rule
// requireAuth uses to tag `authKind` (cookie wins, mirroring readSessionOrBearer). We DERIVE it
// here instead of reading `authKind` so tracking is independent of requireAuth: routes that
// authenticate INLINE (the viewer-metadata GET that `glance read` hits — it reads the session
// directly to shape its own 404/403 JSON, never running requireAuth) leave `authKind`/`user`
// unset, so their CLI hits used to go unrecorded.
function isCliRequest(c: Context<AppEnv>): boolean {
  const isBearer = c.req.header('Authorization')?.startsWith('Bearer ') ?? false
  return isBearer && getCookie(c, SESSION_COOKIE) === undefined
}

// CLI-usage analytics. Mounted on /api/*, it runs AFTER the route, then records one event per
// Bearer-authenticated (CLI) request. `action` is the top-level resource segment — 'upload'
// (deploy), 'sites' (read/list/viewer), 'users', etc. — a stable command bucket that covers every
// current and future CLI endpoint. The write is handed to waitUntil (never blocks the response)
// and web traffic is skipped entirely.
export const trackCliUsage = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  if (!isCliRequest(c)) return
  const action = c.req.path.replace(/^\/api\//, '').split('/')[0] || 'root'
  // Attribute the event to the caller. requireAuth routes already put the live user on the
  // context; inline-auth routes don't, so fall back to resolving the Bearer token ourselves. A
  // garbage/expired token resolves to null and records nothing (an unauthorized request is not
  // usage). Both the resolve and the write ride waitUntil, off the response's critical path.
  await fireAndForget(
    c,
    (async () => {
      const user = c.get('user') ?? (await readSessionOrBearer(c))
      if (!user) return
      await recordEvent(c.get('db'), {
        type: 'cli',
        action,
        userId: user.id,
        cliVersion: parseCliVersion(c.req.header('User-Agent')),
      })
    })(),
  )
})
