import { api } from './api'

// A star is per-user state on a site: one path, two verbs. Both are no-op-safe server-side, so a
// double-click or a retried request converges instead of erroring — which is what lets the UI be
// optimistic without reconciling a conflict.

export interface StarTarget {
  spaceSlug: string
  siteSlug: string
}

export const starPath = (site: StarTarget): string => `/api/sites/${site.spaceSlug}/${site.siteSlug}/star`

export async function setStar(site: StarTarget, starred: boolean): Promise<void> {
  const path = starPath(site)
  if (starred) await api.post(path)
  else await api.delete(path)
}
