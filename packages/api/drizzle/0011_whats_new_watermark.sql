-- "What's New" read watermark. One nullable column on users: the ISO-8601 UTC date through which
-- the user has seen release notes (null = all unread). New signups get it set on the insert paths.
-- Backfill of PRE-EXISTING users to the newest release so nobody is flooded with unread notes for
-- features that already shipped before this column existed. The literal MUST equal
-- NEWEST_RELEASE_DATE of src/whats-new/catalog.ts at this commit (SQL can't import it).
ALTER TABLE `users` ADD `lastSeenReleaseAt` text;--> statement-breakpoint
UPDATE `users` SET `lastSeenReleaseAt` = '2026-07-01T15:00:00.000Z' WHERE `lastSeenReleaseAt` IS NULL;
