// S-D test harness: a real in-memory SQLite (bun:sqlite) wired through drizzle so the
// repo/route helpers run their actual query builders, plus a KV mock matching the
// GLANCE_SESSIONS surface. Cast to the D1 types the app expects — query semantics are
// identical; only the driver differs (D1's `.batch` is shimmed sequentially).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

const MIGRATIONS = ['drizzle/0000_init.sql', 'drizzle/0001_steep_black_bolt.sql']

/** Fresh in-memory DB with the real schema applied. */
export function makeDb(): DrizzleD1Database {
  const sqlite = new Database(':memory:')
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(import.meta.dir, '../..', file), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  const db = drizzle(sqlite) as unknown as DrizzleD1Database & {
    batch(stmts: Promise<unknown>[]): Promise<unknown[]>
  }
  // D1 exposes atomic `.batch`; bun-sqlite does not. Run sequentially (sync driver) so
  // FK-ordered inserts (spaces before space_members) still land in order.
  db.batch = async (stmts) => {
    const out: unknown[] = []
    for (const s of stmts) out.push(await s)
    return out
  }
  return db
}

/** In-memory stand-in for the GLANCE_SESSIONS KV namespace (get/put/delete + ttl peek). */
export function makeKv() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value)
      ttls.set(key, options?.expirationTtl)
      return Promise.resolve()
    },
    delete: (key: string) => {
      store.delete(key)
      ttls.delete(key)
      return Promise.resolve()
    },
    store,
    ttls,
  }
}
