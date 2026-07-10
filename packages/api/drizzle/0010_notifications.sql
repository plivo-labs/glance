-- Homepage notifications (v1: @-mention only). RECIPIENT cascades (a deleted user's notifications
-- are meaningless); actor/site/thread SET NULL so a row survives what it points at (siteLabel keeps
-- the deep-link readable). Composite index serves the unread count + list in one scan, newest-first.
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipientId` text NOT NULL,
	`type` text NOT NULL,
	`actorId` text,
	`siteId` text,
	`siteLabel` text,
	`threadId` text,
	`filePath` text,
	`snippet` text,
	`readAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`recipientId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`threadId`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_read_created` ON `notifications` (`recipientId`,`readAt`,`createdAt`);
