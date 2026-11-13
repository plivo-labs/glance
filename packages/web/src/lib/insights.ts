import { api } from '@/lib/api'

// Mirrors GET /api/sites/:space/:site/stats (owner-only). Counts only, never viewer identities.
export interface SiteInsights {
  days: number
  totalViews: number
  uniqueViewers: number
  series: { date: string; views: number }[] // zero-filled, one row per UTC day, oldest → newest
  pages: { path: string; views: number }[] // top pages by views
}

export const siteInsights = {
  get: (space: string, site: string) => api.get<SiteInsights>(`/api/sites/${space}/${site}/stats`),
}
