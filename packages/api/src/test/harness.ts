// S-D test harness: a real in-memory SQLite (bun:sqlite) wired through drizzle so the
// repo/route helpers run their actual query builders, plus a KV mock matching the
// GLANCE_SESSIONS surface. Cast to the D1 types the app expects — query semantics are
// identical; only the driver differs (D1's `.batch` is shimmed sequentially).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  type NewComment,
  type NewCommentThread,
  type NewEvent,
  type NewFileRow,
  type NewSite,
  type NewSpace,
  type NewUser,
  comments,
  commentThreads,
  events,
  files,
  siteGroupShares,
  siteUserShares,
  sites,
  spaceMembers,
  spaces,
  users,
} from '../db/schema'

const MIGRATIONS = [
  'drizzle/0000_init.sql',
  'drizzle/0001_steep_black_bolt.sql',
  'drizzle/0002_silly_gertrude_yorkes.sql',
  'drizzle/0003_rename_group_visibility.sql',
  'drizzle/0004_drop_public_visibility.sql',
  'drizzle/0005_peaceful_onslaught.sql',
  'drizzle/0006_glance_documents.sql',
]

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

// --- S-SEED: minimal row inserts so route/search specs are authorable. Test-only,
// behavior-preserving; every field defaults to something sensible and overridable. ---

let seedSeq = 0
const nextId = (prefix: string) => `${prefix}-${++seedSeq}`

/** Insert a user; returns its id. Defaults: member role, derived email. */
export async function seedUser(db: DrizzleD1Database, o: Partial<NewUser> = {}): Promise<string> {
  const id = o.id ?? nextId('u')
  await db.insert(users).values({ id, email: o.email ?? `${id}@example.com`, name: o.name ?? null, role: o.role ?? 'member' })
  return id
}

/** Insert a space; returns its id. Defaults: group type, slug/name derived from id. */
export async function seedSpace(db: DrizzleD1Database, o: Partial<NewSpace> & { createdBy: string }): Promise<string> {
  const id = o.id ?? nextId('sp')
  await db
    .insert(spaces)
    .values({ id, slug: o.slug ?? id, name: o.name ?? id, type: o.type ?? 'group', createdBy: o.createdBy })
  return id
}

/** Add a user to a space's membership. */
export async function seedMember(db: DrizzleD1Database, spaceId: string, userId: string): Promise<void> {
  await db.insert(spaceMembers).values({ spaceId, userId })
}

/** Insert a site; returns its id. Defaults: team visibility, active, slug derived from id. */
export async function seedSite(
  db: DrizzleD1Database,
  o: Partial<NewSite> & { spaceId: string; ownerId: string },
): Promise<string> {
  const id = o.id ?? nextId('site')
  await db.insert(sites).values({
    id,
    spaceId: o.spaceId,
    ownerId: o.ownerId,
    slug: o.slug ?? id,
    title: o.title ?? null,
    visibility: o.visibility ?? 'team',
    status: o.status ?? 'active',
  })
  return id
}

/** Grant a user a direct (per-user) share on a site. */
export async function seedUserShare(db: DrizzleD1Database, siteId: string, userId: string): Promise<void> {
  await db.insert(siteUserShares).values({ siteId, userId })
}

/** Grant every member of a (group) space a share on a site. */
export async function seedGroupShare(db: DrizzleD1Database, siteId: string, spaceId: string): Promise<void> {
  await db.insert(siteGroupShares).values({ siteId, spaceId })
}

// --- S-SEED+ : files (+ R2 body), threads, comments. ---

/** Insert a `files` row and, if an R2 mock is given, store its body under the storageKey.
 *  Returns the storageKey so tests can read the same object the row points at. */
export async function seedFile(
  db: DrizzleD1Database,
  r2: { put: (key: string, value: string, opts?: unknown) => Promise<void> } | null,
  siteId: string,
  o: { path: string; text?: string; mimeType?: string; storageKey?: string } & Partial<NewFileRow>,
): Promise<string> {
  const id = o.id ?? nextId('file')
  const storageKey = o.storageKey ?? `${id}/${o.path}`
  const text = o.text ?? ''
  await db.insert(files).values({
    id,
    siteId,
    path: o.path,
    storageKey,
    mimeType: o.mimeType ?? 'text/html',
    size: text.length,
  })
  if (r2) await r2.put(storageKey, text, { httpMetadata: { contentType: o.mimeType ?? 'text/html' } })
  return storageKey
}

/** Insert a `comment_threads` row; returns its id. Defaults: text anchor, open, anchored. */
export async function seedThread(
  db: DrizzleD1Database,
  o: { siteId: string; filePath: string } & Partial<NewCommentThread>,
): Promise<string> {
  const id = o.id ?? nextId('th')
  await db.insert(commentThreads).values({
    id,
    siteId: o.siteId,
    filePath: o.filePath,
    anchorType: o.anchorType ?? 'text',
    anchor: o.anchor ?? null,
    quote: o.quote ?? null,
    contentHash: o.contentHash ?? null,
    anchorStatus: o.anchorStatus ?? 'anchored',
    start: o.start ?? null,
    end: o.end ?? null,
    status: o.status ?? 'open',
    resolvedBy: o.resolvedBy ?? null,
    resolvedAt: o.resolvedAt ?? null,
    createdBy: o.createdBy ?? null,
  })
  return id
}

/** Insert a `comments` row; returns its id. */
export async function seedComment(
  db: DrizzleD1Database,
  o: { threadId: string } & Partial<NewComment>,
): Promise<string> {
  const id = o.id ?? nextId('cm')
  await db.insert(comments).values({
    id,
    threadId: o.threadId,
    authorId: o.authorId ?? null,
    body: o.body ?? 'a comment',
    createdAt: o.createdAt ?? new Date().toISOString(),
    editedAt: o.editedAt ?? null,
    deletedAt: o.deletedAt ?? null,
  })
  return id
}

/** Insert an `events` row; returns its id. Defaults: view type, now. */
export async function seedEvent(db: DrizzleD1Database, o: Partial<NewEvent> = {}): Promise<string> {
  const id = o.id ?? nextId('ev')
  await db.insert(events).values({
    id,
    type: o.type ?? 'view',
    action: o.action ?? null,
    userId: o.userId ?? null,
    siteId: o.siteId ?? null,
    siteLabel: o.siteLabel ?? null,
    cliVersion: o.cliVersion ?? null,
    createdAt: o.createdAt ?? new Date().toISOString(),
  })
  return id
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

/** In-memory stand-in for the GLANCE_FILES R2 bucket: get/put/delete over string bodies,
 *  with a `gets()` counter so the reconcile zero-work gate ("R2.get not invoked") is testable.
 *  `get` returns an object exposing `text()`, `body` (the string is a valid BodyInit), and a
 *  stable `httpEtag`, matching the surface content.ts/upload.ts use. */
export function makeR2() {
  const store = new Map<string, { body: string; httpMetadata?: { contentType?: string } }>()
  let gets = 0
  return {
    get: (key: string) => {
      gets++
      const v = store.get(key)
      if (!v) return Promise.resolve(null)
      return Promise.resolve({
        body: v.body,
        httpEtag: `"${key}"`,
        httpMetadata: v.httpMetadata,
        text: () => Promise.resolve(v.body),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(v.body).buffer),
      })
    },
    put: async (key: string, value: string | ReadableStream, options?: { httpMetadata?: { contentType?: string } }) => {
      const body =
        typeof value === 'string'
          ? value
          : value && typeof (value as ReadableStream).getReader === 'function'
            ? await new Response(value as ReadableStream).text()
            : ''
      store.set(key, { body, httpMetadata: options?.httpMetadata })
    },
    delete: (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
      return Promise.resolve()
    },
    store,
    gets: () => gets,
  }
}
