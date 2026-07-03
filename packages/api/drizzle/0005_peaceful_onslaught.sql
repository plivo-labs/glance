CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`action` text,
	`userId` text,
	`siteId` text,
	`siteLabel` text,
	`cliVersion` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_type_created` ON `events` (`type`,`createdAt`);--> statement-breakpoint
CREATE INDEX `events_site_created` ON `events` (`siteId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `events_user_created` ON `events` (`userId`,`createdAt`);