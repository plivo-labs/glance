-- Performance: covering indexes for the hot access-control + dashboard queries. All are plain
-- CREATE INDEX IF NOT EXISTS (idempotent; no table rebuild — these columns are plain text/ids with
-- no CHECK). Columns picked to serve the lookups NOT already covered by an existing PK/unique index:
--   sites(ownerId)             — GET /api/sites/mine + searchSites owner reach
--   space_members(userId)      — memberSpaceIds (PK leads with spaceId, so userId scans miss it)
--   site_user_shares(userId)   — sharedSiteIds direct grants (PK leads with siteId)
--   site_group_shares(spaceId) — sharedSiteIds/resolveIsShared via-group join (PK leads with siteId)
-- sites(spaceId) is already covered by unique(sites.spaceId, sites.slug); events is already covered
-- by its 0005 composite indexes.
CREATE INDEX IF NOT EXISTS `sites_owner` ON `sites` (`ownerId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `space_members_user` ON `space_members` (`userId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_user_shares_user` ON `site_user_shares` (`userId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_group_shares_space` ON `site_group_shares` (`spaceId`);
