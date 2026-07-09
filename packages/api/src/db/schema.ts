import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

// Column names mirror the spec's SQL exactly (camelCase) so raw `wrangler d1 execute`
// queries in the runbook keep working. IDs are app-generated UUIDs; timestamps are ISO-8601.

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name'),
  googleId: text('googleId').unique(),
  role: text('role', { enum: ['member', 'superadmin'] }).notNull().default('member'),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
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
    visibility: text('visibility', { enum: ['private', 'members', 'team'] })
      .notNull()
      .default('team'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [unique('sites_space_slug_unq').on(t.spaceId, t.slug), index('sites_owner').on(t.ownerId)],
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
  (t) => [index('comments_thread_created').on(t.threadId, t.createdAt), index('comments_author').on(t.authorId)],
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

// Homepage notifications. v1 carries a single `type` ('mention') raised when a user is @-tagged in
// a review comment. FK durability mirrors `events`/`comments`: the RECIPIENT cascades (a deleted
// user's notifications are meaningless), but actor/site/thread are SET NULL so the row survives the
// deletion of what it points at — `siteLabel` denormalizes "space/slug" (captured from route params
// at insert time; the site row only has slug+spaceId, not the space slug) so the deep-link stays
// readable. Inserts are fire-and-forget off the comment path, so a write here never blocks/faults a
// comment. The composite index serves both the unread count and the list in one shot.
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    recipientId: text('recipientId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['mention'] }).notNull(),
    actorId: text('actorId').references(() => users.id, { onDelete: 'set null' }),
    siteId: text('siteId').references(() => sites.id, { onDelete: 'set null' }),
    // Denormalized "space/slug" from the route params at insert — survives a site delete.
    siteLabel: text('siteLabel'),
    threadId: text('threadId').references(() => commentThreads.id, { onDelete: 'set null' }),
    filePath: text('filePath'),
    snippet: text('snippet'),
    // Null = unread; set to an ISO timestamp when marked read.
    readAt: text('readAt'),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  // Unread count + list for one recipient in a single index scan, newest-first.
  (t) => [index('notifications_recipient_read_created').on(t.recipientId, t.readAt, t.createdAt)],
)

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

export type CommentThread = typeof commentThreads.$inferSelect
export type NewCommentThread = typeof commentThreads.$inferInsert
export type Comment = typeof comments.$inferSelect
export type NewComment = typeof comments.$inferInsert
export type DocumentRow = typeof documents.$inferSelect
export type NewDocumentRow = typeof documents.$inferInsert
export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
export type EventType = Event['type']
export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type NotificationType = Notification['type']

export type Visibility = Site['visibility']
export type SpaceType = Space['type']
export type ThreadStatus = CommentThread['status']
