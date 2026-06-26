import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

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
    visibility: text('visibility', { enum: ['private', 'group', 'team', 'public'] })
      .notNull()
      .default('team'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [unique('sites_space_slug_unq').on(t.spaceId, t.slug)],
)

export const files = sqliteTable('files', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  siteId: text('siteId').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  storageKey: text('storageKey').notNull().unique(),
  mimeType: text('mimeType'),
  size: integer('size'),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
})

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

export type Visibility = Site['visibility']
export type SpaceType = Space['type']
