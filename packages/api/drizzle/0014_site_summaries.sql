CREATE TABLE `site_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`summary` text NOT NULL,
	`contentVersion` integer NOT NULL,
	`promptVersion` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`generatedBy` text,
	`truncated` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generatedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_summaries_siteId_unique` ON `site_summaries` (`siteId`);
