import { asc } from 'drizzle-orm'
import { Hono } from 'hono'
import { users as usersTable } from '../db/schema'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export const users = new Hono<AppEnv>()

// GET /api/users — directory for the share picker. Any signed-in member; excludes the
// caller (you don't share with yourself). Single-tenant (one company domain), so exposing
// the full member list is acceptable.
users.get('/', requireAuth, async (c) => {
  const me = c.get('user')
  const db = c.get('db')
  const rows = await db
    .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
    .from(usersTable)
    .orderBy(asc(usersTable.email))
  return c.json(rows.filter((u) => u.id !== me.id))
})
