CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`collection` text NOT NULL,
	`docId` text NOT NULL,
	`json` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_site_collection_doc_unq` ON `documents` (`siteId`,`collection`,`docId`);--> statement-breakpoint
CREATE INDEX `documents_site_collection_creator` ON `documents` (`siteId`,`collection`,`createdBy`);
