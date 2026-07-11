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
  audio?: boolean // every file is audio — a recording/voice site; shows a Mic badge
  hasSummary?: boolean // the site has a stored AI summary; shows a sparkle badge
  // The caller's direct-share role on this site — set on the "Shared with me" feed so an editor row
  // shows a "You can edit" badge. Absent on owned/team feeds.
  role?: ShareRole
  url: string
  createdAt: string
}

export interface TeamUpload extends SiteSummary {
  uploaderName: string | null
  uploaderEmail: string
}

// Mirrors the API's CommentFeedItem (packages/api/src/db/comment-feed.ts) field-for-field — keep in sync.
export interface CommentFeedItem {
  kind: 'mention' | 'authored'
  id: string
  snippet: string | null
  actorName: string | null
  spaceSlug: string
  siteSlug: string
  siteTitle: string | null
  filePath: string
  threadId: string
  threadStatus: 'open' | 'resolved'
  createdAt: string
  editedAt: string | null
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
  // The file the root URL serves (single-file site → that file; else 'index.html'; else '').
  // Lets the viewer pick the audio player at a site's root, not only at its explicit file path.
  indexPath: string
}

export interface UserLite {
  id: string
  email: string
  name: string | null
}

export type ShareRole = 'viewer' | 'editor'

export interface ShareSet {
  userIds: string[]
  groupIds: string[]
  // Role-aware user list (superset of userIds). Present on the new API; a viewer is the default.
  users: { id: string; role: ShareRole }[]
}

export type SlugExists = { exists: false } | { exists: true; owned: boolean }
