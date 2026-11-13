import { api } from '@/lib/api'

// One kept snapshot of a site's content (GET /api/sites/:space/:site/versions, owner only).
// `createdAt` is when the content was REPLACED and `createdBy` who replaced it — the version holds
// what the site was serving just before that.
export interface SiteVersion {
  id: string
  version: number
  createdAt: string
  createdBy: { id: string; name: string | null; email: string } | null
  fileCount: number
  totalSize: number
}

export const siteVersions = {
  list: (space: string, site: string) =>
    api.get<{ versions: SiteVersion[] }>(`/api/sites/${space}/${site}/versions`).then((r) => r.versions),
  restore: (space: string, site: string, id: string) =>
    api.post<{ ok: true; restoredVersion: number; fileCount: number }>(
      `/api/sites/${space}/${site}/versions/${id}/restore`,
    ),
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export const versionAuthor = (v: SiteVersion): string => v.createdBy?.name || v.createdBy?.email || 'someone'
