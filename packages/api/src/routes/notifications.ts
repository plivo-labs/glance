import { Hono } from 'hono'
import { listNotifications, markRead } from '../db/notifications'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// Notifications API, mounted at /api/notifications. User-scoped (not site-scoped): every row is
// keyed to the authenticated recipient, so there is no per-site access gate here — just requireAuth.
// The unread count rides the list response (no separate count endpoint; the root loader carries it).

export const notifications = new Hono<AppEnv>()

notifications.use('*', requireAuth)

// GET — the caller's notifications (newest-first) + the full unread count.
notifications.get('/', async (c) => {
  return c.json(await listNotifications(c.get('db'), c.get('user').id))
})

// POST /read — mark notifications read. Body { ids?: string[] }: omit ids to mark ALL read (opening
// the bell); pass ids to mark specific ones (click-through). A non-array/absent ids marks all.
notifications.post('/read', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const ids = Array.isArray(raw?.ids) ? raw.ids.filter((x: unknown): x is string => typeof x === 'string') : undefined
  await markRead(c.get('db'), c.get('user').id, ids)
  return c.json({ ok: true })
})
