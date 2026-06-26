CREATE TABLE `site_group_shares` (
	`siteId` text NOT NULL,
	`spaceId` text NOT NULL,
	PRIMARY KEY(`siteId`, `spaceId`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_user_shares` (
	`siteId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`siteId`, `userId`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
