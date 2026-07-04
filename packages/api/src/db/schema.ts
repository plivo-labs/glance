import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import type { Anchor } from '../lib/anchor'

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
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] })],
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
  (t) => [unique('sites_space_slug_unq').on(t.spaceId, t.slug)],
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
    // Normalized-text digest (lib/anchor `normalizeText`) of the file body, computed at upload.
    // Nullable: pre-existing rows + non-text files have none. The cheap "hash unchanged → skip
    // re-anchor" gate (Step 8) keys off this.
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
  (t) => [primaryKey({ columns: [t.siteId, t.userId] })],
)

// Explicit per-group sharing: grant every member of a (group) space access to a site.
export const siteGroupShares = sqliteTable(
  'site_group_shares',
  {
    siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    spaceId: text('spaceId').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.spaceId] })],
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
    // 'text' = anchored to a quote; 'page' = whole-page (markdown, or anchoring fallback).
    anchorType: text('anchorType', { enum: ['text', 'page'] }).notNull().default('text'),
    // The stored anchor {quote, prefix, suffix} (lib/anchor). Null for page-level threads.
    anchor: text('anchor', { mode: 'json' }).$type<Anchor>(),
    // Denormalized quote for display and for the client painter to re-find in the rendered DOM.
    quote: text('quote'),
    // DEPRECATED (kept to avoid a destructive D1 migration): the server no longer resolves or
    // reconciles anchors — painting is client-side against the rendered DOM. New rows leave these
    // at their defaults; nothing reads them. Drop in a future migration when convenient.
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

export type Visibility = Site['visibility']
export type SpaceType = Space['type']
export type ThreadStatus = CommentThread['status']
