// The viewer route's loader logic (S11) — kept in lib so the loader contract is unit-testable
// without the component tree. The contract: the loader resolves as soon as SITE META is in (the
// iframe never waits on comments); the comments prefetch is fired UNAWAITED and rides along as a
// pending promise for the component's arbiter to consume.

import { api, ApiError } from './api'
import { comments, type Thread } from './comments'
import { resolveEntryPath } from './entryPath'
import { toLogin } from './nav'
import type { ViewerSite } from './types'

/** Benign failure sentinel: the prefetch promise NEVER rejects (an unconsumed rejection would
 *  surface as an unhandled-rejection error), it resolves to this instead. */
export const PREFETCH_FAILED: unique symbol = Symbol('glance:prefetch-failed')
export type PrefetchResult = Thread[] | typeof PREFETCH_FAILED

export interface ViewerLoaderData {
  site: ViewerSite
  /** Server-normalized entry file (the prefetch key); null = no prefetch (never guess). */
  entryPath: string | null
  /** In-flight comments prefetch for entryPath; null when no prefetch was issued. */
  commentsPromise: Promise<PrefetchResult> | null
}

export async function loadViewer(args: {
  space: string
  site: string
  sitePath: string
  request: Request
}): Promise<ViewerLoaderData> {
  let site: ViewerSite
  try {
    site = await api.get<ViewerSite>(`/api/sites/${args.space}/${args.site}`)
  } catch (err) {
    // 401 → sign in, returning here afterward; 403/404/410 bubble to the ErrorBoundary. Meta
    // failed, so NO prefetch is ever issued (structurally: comments.list is only reached below).
    if (err instanceof ApiError && err.status === 401) throw toLogin(args.request)
    throw err
  }
  const entry = resolveEntryPath(args.sitePath, site.indexPath)
  if (entry === null) return { site, entryPath: null, commentsPromise: null }
  // Fired UNAWAITED: the loader (and thus the iframe) resolves while this is still pending. The
  // catch is attached HERE so a rejection is always observed, even if never consumed.
  const commentsPromise = comments.list(site, entry).catch<PrefetchResult>(() => PREFETCH_FAILED)
  return { site, entryPath: entry, commentsPromise }
}
