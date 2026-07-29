import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

// Column names mirror the spec's SQL exactly (camelCase) so raw `wrangler d1 execute`
// queries in the runbook keep working. IDs are app-generated UUIDs; timestamps are ISO-8601.

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name'),
  googleId: text('googleId').unique(),
  // Google profile photo URL from the OAuth id_token's `picture` claim, refreshed on every login.
  // Never rendered directly by the browser — the avatar route proxies it same-origin (see
  // routes/avatars.ts), so this column is the ONLY place a googleusercontent URL is held.
  // Null for users who predate this column until their next Google login, and for bootstrap users.
  avatarUrl: text('avatarUrl'),
  role: text('role', { enum: ['member', 'superadmin'] }).notNull().default('member'),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  // "What's New" read watermark: the ISO-8601 UTC date through which this user has seen release
  // notes. Nullable — null means "never seen any" (all releases unread). Set on the insert paths
  // (findOrCreateUser / bootstrapSuperadminByEmail) so new signups start caught up. NO catalog
  // import here — keeping the schema catalog-free is what stops the content worker from baking it in.
  lastSeenReleaseAt: text('lastSeenReleaseAt'),
})

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  type: text('type', { enum: ['personal', 'group'] }).notNull(),
  createdBy: text('createdBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
})

export const spaceMembers = sqliteTable(
  'space_members',
  {
    spaceId: text('spaceId').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] }), index('space_members_user').on(t.userId)],
)

export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    spaceId: text('spaceId').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title'),
    // Short blurb derived from the entry HTML's description meta at upload. CONTENT-derived, so a
    // replace overwrites it (title is identity and stays fill-only-null). Feeds the Slack unfurl card.
    description: text('description'),
    visibility: text('visibility', { enum: ['private', 'members', 'team'] })
      .notNull()
      .default('team'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // Monotonic content-revision counter, bumped on every REPLACE. Editor replaces MUST pass the
    // version they pulled (CAS: UPDATE … WHERE contentVersion=?) so a stale redeploy 409s instead
    // of clobbering a newer one; owner replaces treat it as advisory. lastReplacedBy records who
    // last swapped the bytes (owner id or an editor's user id) — read-only provenance today.
    contentVersion: integer('contentVersion').notNull().default(0),
    lastReplacedBy: text('lastReplacedBy'),
    // Provenance for a forked ("remixed") site: the site it was copied from. Null = deployed
    // directly. SET NULL (never cascade) — a fork's R2 objects are its OWN (fork COPIES the bytes
    // to a fresh prefix; an object is referenced by exactly one file row, ever), so deleting the
    // source may only drop the link, never the content.
    forkedFrom: text('forkedFrom').references((): AnySQLiteColumn => sites.id, { onDelete: 'set null' }),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
    // Last content-activity timestamp: set on create, re-stamped on every REPLACE (upload.ts), so a
    // re-deployed site bubbles back to the top of the Team activity feed (createdAt alone froze a busy
    // site at its creation slot). Renames/moves/visibility changes do NOT bump it — content only.
    updatedAt: text('updatedAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique('sites_space_slug_unq').on(t.spaceId, t.slug),
    index('sites_owner').on(t.ownerId),
    // Serves the team feed's `status = ? AND visibility = ? ORDER BY updatedAt DESC LIMIT n`:
    // equality on the leading pair, `updatedAt` last so the ORDER BY is a reverse index scan and
    // the LIMIT stops it early — otherwise the feed's correlated EXISTS columns run once per SITE.
    index('sites_status_visibility_updated').on(t.status, t.visibility, t.updatedAt),
  ],
)

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    storageKey: text('storageKey').notNull().unique(),
    mimeType: text('mimeType'),
    size: integer('size'),
    // R2's httpEtag, denormalized at upload (storage keys are immutable — a replace mints new
    // keys — so the etag is fixed for the row's life). Lets the content worker answer 304/416
    // conditionals with zero R2 ops; NULL on pre-denormalization rows → head() probe fallback.
    etag: text('etag'),
    // RESERVED / currently unused. Was intended to hold a normalized-text digest (lib/anchor
    // `normalizeText`) of the file body to power a "hash unchanged → skip re-anchor" gate, but
    // nothing writes or reads it today (anchors are painted client-side, not reconciled server-
    // side). Kept nullable for a possible future wiring — do NOT drop the column.
    contentHash: text('contentHash'),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  // One row per (site, path): serving picks a file by (siteId, path) via .limit(1), so a
  // duplicate path silently shadows. Upload now rejects dupes before write (storage layer),
  // and this constraint is the backstop.
  (t) => [unique('files_site_path_unq').on(t.siteId, t.path)],
)

// Explicit per-user sharing: grant a specific user access to a site, on top of its
// visibility tier (additive — most useful for `private`). Composite PK = idempotent.
export const siteUserShares = sqliteTable(
  'site_user_shares',
  {
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // Grant tier for THIS user on THIS site. 'viewer' = read-only (the long-standing share
    // semantics, hence the default). 'editor' = may content-replace-redeploy (never rename/move/
    // delete/visibility). Group shares stay view-only — there is no editor row on siteGroupShares.
    role: text('role', { enum: ['viewer', 'editor'] }).notNull().default('viewer'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] }), index('site_user_shares_user').on(t.userId)],
)

// Explicit per-group sharing: grant every member of a (group) space access to a site.
export const siteGroupShares = sqliteTable(
  'site_group_shares',
  {
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    spaceId: text('spaceId').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.spaceId] }), index('site_group_shares_space').on(t.spaceId)],
)

// Per-user "starred" pins on a site — the backing store for the dashboard's Starred tab. The
// composite PK makes the toggle idempotent BY CONSTRUCTION (a double-click can't double-star), and
// the userId index serves the feed's own scan (WHERE userId = ? ORDER BY createdAt DESC). Both FKs
// cascade: a star is a pointer, worthless once either end is gone, so there is no durability case
// for keeping it the way comments/events keep history. A star row carries NO access meaning —
// `checkAccess` stays the only authority, re-run at READ time, so a site that later flips to
// private (or whose share is revoked) drops out of the feed while its row survives for a flip back.
export const siteStars = sqliteTable(
  'site_stars',
  {
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // Orders the Starred feed newest-STAR-first (not newest-site-first) — the whole point of the
    // tab is "what I pinned most recently", which the site's own createdAt cannot express.
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] }), index('site_stars_user').on(t.userId)],
)

// Anchored, threaded review comments on a deployed site's files. A thread anchors to a quote
// in one file (or to the page); comments are FLAT (one level — no parentId). User FKs are
// SET NULL so deleting a user never nukes review history; only site/thread deletes cascade.
export const commentThreads = sqliteTable(
  'comment_threads',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    filePath: text('filePath').notNull(),
    // 'text' = anchored to a quote; 'page' = whole-page (markdown, or anchoring fallback);
    // 'element' = a pinpoint anchor on a whole element (chart/table/image) — payload in `anchor`.
    // Widening this enum needs NO migration: it's a plain text column with no CHECK constraint.
    anchorType: text('anchorType', { enum: ['text', 'page', 'element'] }).notNull().default('text'),
    // The quote the text painter re-finds in the rendered DOM. Null for page/element threads.
    quote: text('quote'),
    // For an 'element' thread, the client-suggested {selector, tag, preview, textFallback} (see
    // lib/anchor buildElementAnchor). For legacy text/page rows this column may still hold the old,
    // now-unused {quote, prefix, suffix} model — readElementAnchor gates on anchorType so that never
    // leaks. prefix/suffix are dead; quote is denormalized to its own column above.
    anchor: text('anchor', { mode: 'json' }),
    // RESERVED / currently unused (mirrors files.contentHash above): no code writes or reads it.
    contentHash: text('contentHash'),
    anchorStatus: text('anchorStatus', { enum: ['anchored', 'shifted', 'suggested', 'orphaned'] })
      .notNull()
      .default('anchored'),
    start: integer('start'),
    end: integer('end'),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
    resolvedBy: text('resolvedBy').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: text('resolvedAt'),
    createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updatedAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index('threads_site_file_status').on(t.siteId, t.filePath, t.status),
    index('threads_site_status_updated').on(t.siteId, t.status, t.updatedAt),
  ],
)

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    threadId: text('threadId').notNull().references(() => commentThreads.id, { onDelete: 'cascade' }),
    authorId: text('authorId').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
    editedAt: text('editedAt'),
    // Soft delete: keeps the row (and thread shape) so history survives; body is redacted on read.
    deletedAt: text('deletedAt'),
    // Voice comments: R2 object key for the recorded audio; null for text comments. The `body`
    // holds the server-side transcript so the CLI/agent review loop still reads everything as text.
    audioKey: text('audioKey'),
  },
  (t) => [
    index('comments_thread_created').on(t.threadId, t.createdAt),
    // Covers the authored feed arm: WHERE authorId = ? AND deletedAt IS NULL ORDER BY createdAt DESC.
    index('comments_author_deleted_created').on(t.authorId, t.deletedAt, t.createdAt),
  ],
)

// Generic per-site document store backing the browser `glance.db` SDK (shared backend).
// One flat table keyed by (siteId, collection, docId) holding an opaque JSON blob — this is
// what gives the schemaless collection() DX without a migration per collection. INVARIANTS:
// `siteId` is ALWAYS derived server-side from the verified data token (never a client field),
// so the composite key is the tenant boundary; `createdBy` is server-set from the token viewer
// and drives the default per-creator read policy. `json` is stored as TEXT (drizzle json mode).
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    docId: text('docId').notNull(),
    json: text('json', { mode: 'json' }).$type<unknown>().notNull(),
    createdBy: text('createdBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updatedAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique('documents_site_collection_doc_unq').on(t.siteId, t.collection, t.docId),
    index('documents_site_collection_creator').on(t.siteId, t.collection, t.createdBy),
  ],
)

// Append-only per-site change stream for `glance.db` realtime push. Every documents mutation
// writes exactly one row here in the SAME db.batch, so a client that reconnects — or notices a
// gap — replays from a cursor instead of going permanently stale (Cloudflare terminates every
// WebSocket on a DO shutdown, INCLUDING each code deploy, so replay is not optional).
// INVARIANTS: `createdBy` is the DOCUMENT's creator captured at mutation time, NOT the writer —
// an owner moderating someone else's row must fan out against the row's identity or the push
// becomes an IDOR. `seq` is per SITE, never global: a site-wide counter is what a cursor is
// expressed in, and one site's traffic must not be derivable from another's.
export const changeLog = sqliteTable(
  'change_log',
  {
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    // Assigned in-SQL as max(seq)+1 over this siteId inside the mutation's own batch — no
    // read-modify-write round trip, the same trick as `sql\`${sites.contentVersion} + 1\``. There is
    // no autoincrement/rowid PK anywhere in this schema and this is deliberately not the first:
    // the counter must restart per site, and the composite PK below makes it unique and gap-free.
    seq: integer('seq').notNull(),
    collection: text('collection').notNull(),
    docId: text('docId').notNull(),
    // Denormalized, with NO users FK on purpose (unlike documents.createdBy): `cascade` would
    // delete the very replay rows a reconnecting client needs, and `set null` would erase the
    // identity the fan-out visibility filter reads. Durability beats referential tidiness here.
    createdBy: text('createdBy').notNull(),
    type: text('type', { enum: ['create', 'update', 'delete'] }).notNull(),
    at: text('at').notNull(),
  },
  // Doubles as the catch-up scan index: WHERE siteId = ? AND seq > cursor ORDER BY seq.
  (t) => [primaryKey({ columns: [t.siteId, t.seq] })],
)

// Usage-analytics event stream. Append-only; one row per tracked action:
//   type 'view' — a top-level HTML page served by the content worker (action = file path).
//   type 'cli'  — a Bearer-authenticated API call from the CLI (action = route, e.g. 'upload').
// User/site FKs are SET NULL (not cascade) so deleting a user or site never erases historical
// counts — same durability rule the comments table follows. siteLabel denormalizes "space/site"
// so the row stays human-readable after its site is gone. Writes go through ctx.waitUntil on the
// serving path, so recording an event never blocks the response.
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    type: text('type', { enum: ['view', 'cli'] }).notNull(),
    // view: served file path; cli: the API route/command (e.g. 'upload', 'comments', 'read').
    action: text('action'),
    userId: text('userId').references(() => users.id, { onDelete: 'set null' }),
    siteId: text('siteId').references(() => sites.id, { onDelete: 'set null' }),
    // Denormalized "space/site" slug pair — survives a site delete for readable per-site rollups.
    siteLabel: text('siteLabel'),
    // CLI semver from the User-Agent (glance-cli/<version>); null for views and legacy CLIs.
    cliVersion: text('cliVersion'),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index('events_type_created').on(t.type, t.createdAt),
    index('events_site_created').on(t.siteId, t.createdAt),
    index('events_user_created').on(t.userId, t.createdAt),
  ],
)

// Homepage notifications. Notifications carry type 'mention' (@-tag) or 'comment' (activity on your
// sites / threads you participate in); `commentId` identifies the triggering comment for feed
// dedupe. FK durability mirrors `events`/`comments`: the RECIPIENT cascades (a deleted user's
// notifications are meaningless), but actor/site/thread/comment are SET NULL so the row survives the
// deletion of what it points at — `siteLabel` denormalizes "space/slug" (captured from route params
// at insert time; the site row only has slug+spaceId, not the space slug) so the deep-link stays
// readable. Inserts are fire-and-forget off the comment path, so a write here never blocks/faults a
// comment. The composite index serves both the unread count and the list in one shot.
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    recipientId: text('recipientId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['mention', 'comment'] }).notNull(),
    actorId: text('actorId').references(() => users.id, { onDelete: 'set null' }),
    siteId: text('siteId').references(() => sites.id, { onDelete: 'set null' }),
    // Denormalized "space/slug" from the route params at insert — survives a site delete.
    siteLabel: text('siteLabel'),
    threadId: text('threadId').references(() => commentThreads.id, { onDelete: 'set null' }),
    commentId: text('commentId').references(() => comments.id, { onDelete: 'set null' }),
    filePath: text('filePath'),
    snippet: text('snippet'),
    // Null = unread; set to an ISO timestamp when marked read.
    readAt: text('readAt'),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // Unread count + list for one recipient in a single index scan, newest-first.
    index('notifications_recipient_read_created').on(t.recipientId, t.readAt, t.createdAt),
    // Supports comment FK maintenance when a comment is hard-deleted through a site/thread cascade.
    index('notifications_comment').on(t.commentId),
  ],
)

// One row per site (`siteId` unique): site deletion cascades, while `generatedBy` is SET NULL so
// summaries survive author deletion. Server-computed `contentVersion` + `promptVersion` together
// determine staleness.
export const siteSummaries = sqliteTable('site_summaries', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  siteId: text('siteId').notNull().unique().references(() => sites.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  contentVersion: integer('contentVersion').notNull(),
  promptVersion: integer('promptVersion').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  generatedBy: text('generatedBy').references(() => users.id, { onDelete: 'set null' }),
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdate(() => new Date().toISOString()),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Space = typeof spaces.$inferSelect
export type NewSpace = typeof spaces.$inferInsert
export type SpaceMember = typeof spaceMembers.$inferSelect
export type Site = typeof sites.$inferSelect
export type NewSite = typeof sites.$inferInsert
export type FileRow = typeof files.$inferSelect
export type NewFileRow = typeof files.$inferInsert
export type SiteUserShare = typeof siteUserShares.$inferSelect
export type SiteGroupShare = typeof siteGroupShares.$inferSelect
export type SiteStar = typeof siteStars.$inferSelect

export type CommentThread = typeof commentThreads.$inferSelect
export type NewCommentThread = typeof commentThreads.$inferInsert
export type Comment = typeof comments.$inferSelect
export type NewComment = typeof comments.$inferInsert
export type DocumentRow = typeof documents.$inferSelect
export type NewDocumentRow = typeof documents.$inferInsert
export type ChangeLogRow = typeof changeLog.$inferSelect
export type ChangeType = ChangeLogRow['type']
export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
export type EventType = Event['type']
export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type NotificationType = Notification['type']
export type SiteSummary = typeof siteSummaries.$inferSelect

export type Visibility = Site['visibility']
export type SpaceType = Space['type']
export type ThreadStatus = CommentThread['status']
