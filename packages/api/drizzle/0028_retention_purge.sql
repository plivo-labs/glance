-- Retention purge (issue #82 / #102 item 2). Two things the purge needs and the schema didn't have:
--
-- 1. `purged_event_counts`: a durable counter for `events` rows the purge deletes, so
--    stats.ts's all-time `totals.views` can add the purged count back instead of silently
--    shrinking as history ages out from under it.
CREATE TABLE `purged_event_counts` (
	`type` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- 2. The purge's notifications delete is `WHERE readAt IS NOT NULL AND createdAt < cutoff` with
--    no recipient filter — neither existing notifications index (both lead with `recipientId`)
--    serves that shape, so it would full-scan every run. `readAt` leads so the IS NOT NULL half is
--    a range scan (skips the NULL/unread rows entirely), `createdAt` second for the cutoff range.
CREATE INDEX `notifications_read_created` ON `notifications` (`readAt`,`createdAt`);
