-- editor-share: a named user may content-replace-redeploy a site (not the whole team).
-- Three plain ADD COLUMNs (no table rebuild; text/integer, no CHECK):
--   site_user_shares.role  — 'viewer' (default, = today's read-only share) | 'editor'. Every
--     existing share row backfills to 'viewer', so behavior is unchanged until a role is set.
--   sites.contentVersion   — monotonic revision counter (default 0), bumped on REPLACE. Editor
--     replaces CAS on it (UPDATE … WHERE contentVersion=?) → 409 on a stale redeploy.
--   sites.lastReplacedBy   — nullable provenance: who last swapped the bytes.
ALTER TABLE `site_user_shares` ADD `role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `contentVersion` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `lastReplacedBy` text;
