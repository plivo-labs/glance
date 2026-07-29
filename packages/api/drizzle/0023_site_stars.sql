-- Per-user "starred" pins on a site, backing the dashboard's Starred tab. The composite primary key
-- is what makes the toggle idempotent by construction — a double-click cannot write a second row —
-- and the userId index serves the feed's own scan (WHERE userId = ? ORDER BY createdAt DESC). Both
-- foreign keys cascade: a star is a pointer, worthless once either end is gone, so unlike
-- comments/events there is no history to preserve. `createdAt` orders the feed newest-STAR-first,
-- which the site's own createdAt cannot express.
CREATE TABLE `site_stars` (
	`siteId` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`siteId`, `userId`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_stars_user` ON `site_stars` (`userId`);
