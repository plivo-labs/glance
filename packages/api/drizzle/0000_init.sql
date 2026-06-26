CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`path` text NOT NULL,
	`storageKey` text NOT NULL,
	`mimeType` text,
	`size` integer,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_storageKey_unique` ON `files` (`storageKey`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`spaceId` text NOT NULL,
	`slug` text NOT NULL,
	`title` text,
	`visibility` text DEFAULT 'team' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ownerId` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_space_slug_unq` ON `sites` (`spaceId`,`slug`);--> statement-breakpoint
CREATE TABLE `space_members` (
	`spaceId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`spaceId`, `userId`),
	FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_slug_unique` ON `spaces` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`googleId` text,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_googleId_unique` ON `users` (`googleId`);