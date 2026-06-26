import { drizzle } from 'drizzle-orm/d1'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

// Per-request drizzle client — the D1 binding is request-scoped in Workers, so the
// client must not be memoized across requests. Attaches c.get('db').
export const withDb = createMiddleware<AppEnv>(async (c, next) => {
  c.set('db', drizzle(c.env.GLANCE_DB))
  await next()
})
