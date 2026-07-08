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
