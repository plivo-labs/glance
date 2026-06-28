CREATE TABLE `comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`filePath` text NOT NULL,
	`anchorType` text DEFAULT 'text' NOT NULL,
	`anchor` text,
	`quote` text,
	`contentHash` text,
	`anchorStatus` text DEFAULT 'anchored' NOT NULL,
	`start` integer,
	`end` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`resolvedBy` text,
	`resolvedAt` text,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_site_file_status` ON `comment_threads` (`siteId`,`filePath`,`status`);--> statement-breakpoint
CREATE INDEX `threads_site_status_updated` ON `comment_threads` (`siteId`,`status`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`threadId` text NOT NULL,
	`authorId` text,
	`body` text NOT NULL,
	`createdAt` text NOT NULL,
	`editedAt` text,
	`deletedAt` text,
	FOREIGN KEY (`threadId`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `comments_thread_created` ON `comments` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `comments_author` ON `comments` (`authorId`);--> statement-breakpoint
ALTER TABLE `files` ADD `contentHash` text;--> statement-breakpoint
DELETE FROM `files` WHERE `rowid` NOT IN (SELECT MAX(`rowid`) FROM `files` GROUP BY `siteId`, `path`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_site_path_unq` ON `files` (`siteId`,`path`);