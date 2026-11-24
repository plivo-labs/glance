-- Optional per-site expiry: `expiresAt` (ISO-8601 UTC, null = never) and a third site status,
-- 'expired', kept apart from the admin-only 'archived'. The hourly cron flips active sites whose
-- expiresAt has passed (lib/expiry.ts); the index serves that sweep.
ALTER TABLE `sites` ADD COLUMN `expiresAt` text;
--> statement-breakpoint
CREATE INDEX `sites_expires` ON `sites` (`expiresAt`);
