// Mirrors the API response contract (packages/api routes).

export type Visibility = 'private' | 'members' | 'team'
export type SiteStatus = 'active' | 'archived'

export interface Me {
  id: string
  email: string
  name: string | null
  role: 'member' | 'superadmin'
}

// GET /api/config — public first-run config driving which login options the page offers.
export interface PublicConfig {
  googleEnabled: boolean
  bootstrapAvailable: boolean
}

export interface SpaceSummary {
  id: string
  slug: string
  name: string
  type: 'personal' | 'group'
}

export interface SpaceDetail extends SpaceSummary {
  memberCount: number
  isMember: boolean
}

export interface SiteSummary {
  id: string
  spaceSlug: string
  siteSlug: string
  title: string | null
  visibility: Visibility
  status: SiteStatus
  url: string
  createdAt: string
}

export interface TeamUpload extends SiteSummary {
  uploaderName: string | null
  uploaderEmail: string
}

export interface ViewerSite {
  id: string
  spaceSlug: string
  siteSlug: string
  title: string | null
  visibility: Visibility
  status: SiteStatus
  isOwner: boolean
  contentUrl: string
}

export interface UserLite {
  id: string
  email: string
  name: string | null
}

export interface ShareSet {
  userIds: string[]
  groupIds: string[]
}

export type SlugExists = { exists: false } | { exists: true; owned: boolean }
