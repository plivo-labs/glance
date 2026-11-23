-- Version history for a site. A replace (or restore) moves the file rows it replaces into a version
-- instead of deleting their R2 objects. `site_version_files.storageKey` is UNIQUE like files.storageKey:
-- a snapshot moves a key from `files` to here in one batch, so an object is still owned by exactly one
-- row. `createdAt` is the snapshot time (retention ages by it), `createdBy` the actor who replaced.
-- Both tables cascade with the site; the R2 keys are purged by the app BEFORE the site row goes.
CREATE TABLE `site_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` text NOT NULL,
	`createdBy` text,
	`fileCount` integer NOT NULL,
	`totalSize` integer NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `site_versions_site_created` ON `site_versions` (`siteId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `site_version_files` (
	`versionId` text NOT NULL,
	`path` text NOT NULL,
	`storageKey` text NOT NULL,
	`mimeType` text,
	`size` integer,
	`etag` text,
	PRIMARY KEY(`versionId`, `path`),
	FOREIGN KEY (`versionId`) REFERENCES `site_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_version_files_storageKey_unique` ON `site_version_files` (`storageKey`);
