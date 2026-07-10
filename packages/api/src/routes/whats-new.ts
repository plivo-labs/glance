import { Hono } from 'hono'
import { getWatermark, setSeen } from '../db/whats-new'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'
import { NEWEST_RELEASE_DATE } from '../whats-new/catalog'
import { isCanonicalDate } from '../whats-new/bake'
import { listReleases, unreadCount } from '../whats-new/query'

// "What's New" API, mounted at /api/whats-new. User-scoped (watermark keyed to the caller), so no
// per-site gate — just requireAuth. Thin controller: the unread math lives in whats-new/query and
// the clamp lives in db/whats-new; this file only wires them and validates the /seen input.

export const whatsNew = new Hono<AppEnv>()

whatsNew.use('*', requireAuth)

// GET — the release archive (newest-first) + this user's unread count + the date to POST back to
// mark everything seen (the newest release date, or null when the catalog is empty).
whatsNew.get('/', async (c) => {
  const watermark = await getWatermark(c.get('db'), c.get('user').id)
  return c.json({ items: listReleases(), unreadCount: unreadCount(watermark), throughDate: NEWEST_RELEASE_DATE })
})

// POST /seen — advance the watermark to { throughDate }. Reject a non-canonical date (offset,
// date-only, variable precision, bad calendar) with 400 BEFORE any write, so the watermark can
// never be corrupted; the keep-larger clamp is enforced in setSeen.
whatsNew.post('/seen', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { throughDate?: unknown } | null
  const throughDate = body?.throughDate
  if (typeof throughDate !== 'string' || !isCanonicalDate(throughDate)) {
    return c.json({ error: 'throughDate must be a canonical ISO-8601 UTC date (…SS.sssZ)' }, 400)
  }
  await setSeen(c.get('db'), c.get('user').id, throughDate, NEWEST_RELEASE_DATE)
  return c.json({ ok: true })
})
