// Mirrors the API response contract (packages/api routes).

export type Visibility = 'private' | 'members' | 'team'
export type SiteStatus = 'active' | 'archived'

export interface Me {
  id: string
  email: string
  name: string | null
  role: 'member' | 'superadmin'
  // True once any Bearer-authenticated CLI call landed an events row — gates the install banner.
  hasUsedCli: boolean
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
  isOwner: boolean
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
  // Whether the CALLER has starred this site — per-user state riding a shared feed, never the
  // owner's. Absent on legacy payloads, so treat undefined as "not starred".
  starred?: boolean
  // The caller's direct-share role on this site — set on the "Shared with me" feed so an editor row
  // shows a "You can edit" badge. Absent on owned/team feeds.
  role?: ShareRole
  url: string
  createdAt: string
  updatedAt: string // last content activity (create or most-recent replace); drives Team activity order
}

export interface TeamUpload extends SiteSummary {
  uploaderId: string
  uploaderName: string | null
  uploaderEmail: string
}

// Mirrors the API's CommentFeedItem (packages/api/src/db/comment-feed.ts) field-for-field — keep in sync.
export interface CommentFeedItem {
  kind: 'mention' | 'authored' | 'owned'
  id: string
  snippet: string | null
  actorId: string | null
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
  // The caller's own star on this site, resolved in the viewer's single metadata batch so the
  // top-bar button is correct on first paint.
  starred?: boolean
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

// Mirrors packages/api/src/routes/api-keys.ts KEY_DURATIONS — the only expiries the server will
// ever accept. Keep this list in sync with that one; it is what drives the expiry dropdown.
export const KEY_DURATIONS = [1, 7, 30, 90, 180, 365] as const

export type DataCapability = 'read' | 'create' | 'write' | 'read_all'

// Mirrors packages/api/src/lib/api-key.ts API_KEY_PREFIX — the server derives `secretHint` from
// it, so a locally-built hint (the mint response never round-trips through GET) has to use the
// same constant or the two silently drift.
export const API_KEY_PREFIX = 'glk_'

// The capability CEILING a key may carry, as the three tiers that are actually meaningful against
// the server's dataCapsFor: it intersects this with what the user themselves can do, so a tier can
// only ever narrow. Offering the four raw capabilities as independent checkboxes would let someone
// build combinations the server can never grant (read_all without read, say) and read as more
// control than it is.
export const DATA_LEVELS = [
  { value: 'read', label: 'Read only', caps: ['read'] },
  { value: 'submit', label: 'Read & submit', caps: ['read', 'create'] },
  { value: 'full', label: 'Full access', caps: ['read', 'create', 'write', 'read_all'] },
] as const satisfies ReadonlyArray<{ value: string; label: string; caps: readonly DataCapability[] }>

export type DataLevel = (typeof DATA_LEVELS)[number]['value']

// Mirrors packages/api/src/lib/api-key.ts ApiKeyGrants.
export type ApiKeyGrants = {
  control: boolean
  data: { scope: { kind: 'all-owned' } | { kind: 'sites'; siteIds: string[] }; caps: DataCapability[] } | null
}

// GET /api/api-keys row shape. Never carries the plaintext secret — only `secretHint`
// (`glk_…4mR2`), which the server derives from the last 4 chars of a value it never stores.
export interface ApiKeyItem {
  id: string
  name: string
  grants: ApiKeyGrants
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  secretHint: string | null
}

// POST /api/api-keys response — the ONLY payload that ever carries the plaintext secret.
export interface MintedApiKey {
  id: string
  name: string
  secret: string
  grants: ApiKeyGrants
  createdAt: string
  expiresAt: string
}
