-- "Last activity" timestamp for the Team activity feed: set on create + re-stamped on every content
-- REPLACE (upload.ts) so a re-deployed site bubbles back to the top instead of staying frozen at its
-- creation slot. Plain ADD COLUMN (nullable, no table rebuild), then backfill every existing row to
-- its createdAt so the first sort is stable. New rows get it from the schema $defaultFn; the replace
-- path stamps the current time. Content-only — renames/moves/visibility changes never touch it.
ALTER TABLE `sites` ADD COLUMN `updatedAt` text;--> statement-breakpoint
UPDATE `sites` SET `updatedAt` = `createdAt` WHERE `updatedAt` IS NULL;
