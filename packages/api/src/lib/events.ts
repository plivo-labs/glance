import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { Context } from 'hono'
import { type NewEvent, events } from '../db/schema'

// Best-effort usage-analytics write. NEVER throws: a failed insert must not break page serving
// or an API response. Callers hand this to ctx.waitUntil so it runs after the response is sent,
// keeping the D1 write off the request's critical path.
export async function recordEvent(db: DrizzleD1Database, e: NewEvent): Promise<void> {
  try {
    await db.insert(events).values(e)
  } catch {
    // Swallow — analytics is non-critical and must never surface to the caller.
  }
}

// Hand a best-effort write to the Workers runtime's waitUntil so it runs off the response's
// critical path. In tests there is no ExecutionContext (c.executionCtx throws), so fall back to
// awaiting inline — keeps assertions deterministic without ever blocking the real serving path.
export async function fireAndForget(c: Context, write: Promise<unknown>): Promise<void> {
  try {
    c.executionCtx.waitUntil(write)
  } catch {
    await write
  }
}

// Extract the CLI semver from a `glance-cli/<version>` User-Agent. Returns null for browsers,
// unknown agents, or legacy CLIs that send no version.
export function parseCliVersion(userAgent: string | undefined): string | null {
  const match = userAgent?.match(/glance-cli\/(\S+)/)
  return match?.[1] ?? null
}
