import { and, eq, isNotNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { comments, commentThreads, files, sites } from '../db/schema'

export const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20MB/file (spec resolved decision #3)

/** Remove ASCII control chars (incl. NUL, 0x00-0x1F, and DEL 0x7F) without using
 *  control-char literals in source. */
function stripControlChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code > 31 && code !== 127) out += ch
  }
  return out
}

/**
 * Sanitize an uploaded relative path before it becomes part of an R2 key:
 * normalize separators, drop null/control chars, and strip `.`/`..` segments so
 * traversal is impossible. Keeps `/` separators so folder structure + relative
 * asset links survive.
 */
export function sanitizePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => stripControlChars(s).trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}

/** Delete R2 objects by exact key, batched (R2 caps delete at 1000 keys/call). */
export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000))
  }
}

// Bounded parallelism for the fork copy loop — mirrors the upload put loop, sized well under the
// Workers subrequest budget (a fork is 2 subrequests per file: one get + one put).
const COPY_CONCURRENCY = 10

export type CopyableFile = { path: string; storageKey: string; mimeType: string | null; size: number | null }

/**
 * Copy a site's stored objects to a FRESH uuid prefix (fork). Returns the new file rows.
 *
 * The bytes are genuinely copied — a fork never shares an R2 object with its source. That keeps the
 * system's core storage invariant intact: **an object is referenced by exactly one `files` row**, so
 * deleting any site only ever deletes objects nothing else can reach. (The alternative — sharing keys
 * and reference-counting the deletes — makes every delete path capable of stranding a live site, to
 * optimize an operation that happens far less often than deploy. Not worth it.)
 *
 * The Workers R2 binding has no server-side copy, so this is a real get→put per file
 * (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). If ANY object fails or
 * is missing, every key written so far is deleted and the error propagates — the caller must not have
 * committed rows yet, so a fork can never commit pointing at absent bytes.
 */
export async function copyObjects(
  bucket: R2Bucket,
  rows: CopyableFile[],
  prefix: string,
): Promise<CopyableFile[]> {
  const plan = rows.map((r) => ({ from: r.storageKey, to: `${prefix}/${r.path}`, row: r }))
  const written: string[] = []
  try {
    for (let i = 0; i < plan.length; i += COPY_CONCURRENCY) {
      await Promise.all(
        plan.slice(i, i + COPY_CONCURRENCY).map(async ({ from, to, row }) => {
          const object = await bucket.get(from)
          if (!object) throw new Error(`source object missing: ${from}`)
          written.push(to)
          await bucket.put(to, object.body, {
            httpMetadata: { contentType: row.mimeType ?? 'application/octet-stream' },
          })
        }),
      )
    }
  } catch (err) {
    await deleteKeys(bucket, written)
    throw err
  }
  return plan.map(({ to, row }) => ({ path: row.path, storageKey: to, mimeType: row.mimeType, size: row.size }))
}

/** Delete all R2 objects recorded for a site: the site's uploaded files AND its voice-comment
 *  audio (comments ⨝ threads on this site with a non-null audioKey), batched ≤1000. */
export async function deleteSiteObjects(db: DrizzleD1Database, bucket: R2Bucket, siteId: string): Promise<void> {
  const fileRows = await db.select({ storageKey: files.storageKey }).from(files).where(eq(files.siteId, siteId))
  const audioRows = await db
    .select({ audioKey: comments.audioKey })
    .from(comments)
    .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
    .where(and(eq(commentThreads.siteId, siteId), isNotNull(comments.audioKey)))
  const audioKeys = audioRows.map((r) => r.audioKey).filter((k): k is string => k !== null)
  await deleteKeys(bucket, [...fileRows.map((r) => r.storageKey), ...audioKeys])
}

/** Delete all R2 objects for EVERY site in a space: uploaded files (files ⨝ sites) AND voice-comment
 *  audio (comments ⨝ threads ⨝ sites), both filtered by spaceId, batched ≤1000. Replaces the N+1
 *  per-site `deleteSiteObjects` loop on space delete. */
export async function deleteSpaceObjects(db: DrizzleD1Database, bucket: R2Bucket, spaceId: string): Promise<void> {
  const fileRows = await db
    .select({ storageKey: files.storageKey })
    .from(files)
    .innerJoin(sites, eq(files.siteId, sites.id))
    .where(eq(sites.spaceId, spaceId))
  const audioRows = await db
    .select({ audioKey: comments.audioKey })
    .from(comments)
    .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
    .innerJoin(sites, eq(commentThreads.siteId, sites.id))
    .where(and(eq(sites.spaceId, spaceId), isNotNull(comments.audioKey)))
  const audioKeys = audioRows.map((r) => r.audioKey).filter((k): k is string => k !== null)
  await deleteKeys(bucket, [...fileRows.map((r) => r.storageKey), ...audioKeys])
}
