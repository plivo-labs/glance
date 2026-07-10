// The object-read layer of the content worker: full-200 reads of immutable stored objects,
// fronted by the Workers edge cache when one is available. Zero Hono coupling — callers hand
// in the cache, the bucket, and a `defer` hook for off-critical-path work.

// Minimal surface of the Workers Cache API this layer uses — typed to what the harness mock
// and `caches.default` both satisfy, so we never fight the full workers-types Cache shape.
export type CacheLike = {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

// A stored object body: R2 streams, the harness mock hands owned bytes. Bytes are re-readable,
// streams must be tee'd before feeding two consumers (client response + cache warm).
type StoredBody = ReadableStream | Uint8Array

// Minimal surface of the R2 bucket this layer uses (the plain full `get`): the real R2Bucket
// binding satisfies it structurally, the harness mock hands owned bytes instead of a stream.
export type BucketLike = {
  get(key: string): Promise<{ body: StoredBody; httpEtag: string } | null>
}

/** Cache-control for immutable bytes: cache entries here, and the content worker's
 *  content-versioned client assets. */
export const IMMUTABLE = 'public, max-age=31536000, immutable'

// Synthetic, collision-proof cache key: every storageKey path segment is percent-encoded, so
// keys containing '#', '?', '%', unicode… can never merge into the same URL ('a#b/x' and
// 'a%23b/x' stay distinct). storageKeys are UUID-prefixed and IMMUTABLE (a site replace mints
// new keys), so entries never need invalidation.
export function storageCacheKey(storageKey: string): string {
  return `https://r2.glance-cache.internal/${storageKey.split('/').map(encodeURIComponent).join('/')}`
}

function teeBody(body: StoredBody): [StoredBody, StoredBody] {
  return body instanceof ReadableStream ? body.tee() : [body, body]
}

export type FullRead = { body: StoredBody; etag: string }

/** Full-200 read of an immutable object, served through the edge cache when one is available.
 *  cache.match → hit: the stored raw bytes + the etag stamped on the entry. Miss (or a cache
 *  that throws — a broken cache must never break serving): ONE full R2 get; the body is tee'd
 *  so the client streams immediately while cache.put warms off the critical path via `defer`
 *  (waitUntil in prod; awaited inline in tests). The put carries its own catch — a failed
 *  warm can never surface. Callers consume `body` exactly once. Null = object missing. */
export async function readFullObject(
  cache: CacheLike | null,
  bucket: BucketLike,
  storageKey: string,
  contentTypeHeader: string,
  defer: (p: Promise<unknown>) => Promise<void>,
): Promise<FullRead | null> {
  const key = storageCacheKey(storageKey)
  if (cache) {
    let hit: Response | undefined
    try {
      hit = await cache.match(key)
    } catch {
      // fall through to R2 — still a 200, just uncached
    }
    if (hit?.body) return { body: hit.body, etag: hit.headers.get('etag') ?? '' }
  }
  const object = await bucket.get(storageKey)
  if (!object) return null
  const [clientBody, cacheBody] = teeBody(object.body)
  if (cache) {
    // The STORED entry carries cacheable headers (raw immutable bytes); the CLIENT response
    // keeps its own `private, no-cache` + etag + CSP — the two never share a Headers object.
    const stored = new Response(cacheBody, {
      headers: { etag: object.httpEtag, 'content-type': contentTypeHeader, 'cache-control': IMMUTABLE },
    })
    await defer(cache.put(key, stored).catch(() => {}))
  }
  return { body: clientBody, etag: object.httpEtag }
}
