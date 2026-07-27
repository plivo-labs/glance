// Thin fetch wrapper — every call sends the session cookie. Throws ApiError on non-2xx
// so route loaders/actions can `throw` into React Router error boundaries.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** D1 session bookmark round-trip (issue #79): the server tags responses with the newest
 *  bookmark; echoing it back anchors its next D1 session so reads on a replica still see
 *  this browser's prior writes. */
export const BOOKMARK_HEADER = 'x-glance-d1-bookmark'

let dbBookmark: string | null = null
export const __resetDbBookmark = () => {
  dbBookmark = null
}

/** Feed a bookmark captured outside this wrapper (the XHR upload path) into the round-trip. */
export const captureDbBookmark = (bookmark: string | null) => {
  dbBookmark = bookmark ?? dbBookmark
}

/** Current bookmark, for requests made outside this wrapper (the XHR upload path). */
export const getDbBookmark = () => dbBookmark

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = dbBookmark ? { ...init?.headers, [BOOKMARK_HEADER]: dbBookmark } : init?.headers
  const res = await fetch(path, { credentials: 'include', ...init, headers })
  captureDbBookmark(res.headers.get(BOOKMARK_HEADER))
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // non-JSON error body — keep statusText
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, jsonInit('POST', body)),
  // Multipart POST (voice comments): never set content-type — the browser adds the multipart
  // boundary itself. The session cookie still rides along via request()'s credentials: 'include'.
  postForm: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  put: <T>(path: string, body?: unknown) => request<T>(path, jsonInit('PUT', body)),
  patch: <T>(path: string, body?: unknown) => request<T>(path, jsonInit('PATCH', body)),
  delete: <T>(path: string) => request<T>(path, jsonInit('DELETE')),
}
